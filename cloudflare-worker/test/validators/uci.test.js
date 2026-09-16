import { describe, test } from 'node:test';
import { validateUciConfigs } from '../../src/validators.js';
import { CONFIG, fileDiff, assertNoErrors, assertErrorIncludes, assertSomeIncludes } from './helpers.js';

// The check reads file contents through fetchFileContent, never from the
// patch, which only names the changed files. This serves exactly the given
// files; any other path reads as missing.
const repo = (files) => async (path) => Object.hasOwn(files, path) ? files[path] : null;

const NOT_UCI = "destined for '/etc/config/' but is not a valid UCI configuration file";

describe('validateUciConfigs', () => {
  const rejected = [
    {
      name: 'still validates a file whose explicit install line points at /etc/config',
      patch: fileDiff('package/utils/mypkg/files/mypkg.json', []),
      files: {
        'package/utils/mypkg/Makefile': [
          'PKG_NAME:=mypkg',
          'define Package/mypkg/install',
          '\t$(INSTALL_CONF) ./files/mypkg.json $(1)/etc/config/mypkg',
          'endef'
        ].join('\n'),
        'package/utils/mypkg/files/mypkg.json': '{ "not": "uci" }\n'
      }
    },
    {
      name: 'rejects raw TOML at etc/config path',
      patch: fileDiff('package/utils/foo/files/foo.toml', []),
      files: {
        'package/utils/foo/Makefile': `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.toml $(1)/etc/config/foo
endef
        `,
        'package/utils/foo/files/foo.toml': `
[foo]
enabled = true
hostname = "OpenWrt"
        `
      }
    },
    {
      name: 'identifies etc/config file via conffiles block',
      patch: fileDiff('package/utils/foo/files/foo.conf', []),
      files: {
        'package/utils/foo/Makefile': `
define Package/foo/conffiles
/etc/config/foo
endef
        `,
        'package/utils/foo/files/foo.conf': 'invalid_key = "value"'
      }
    },
    {
      name: 'directly recognizes files with /etc/config/ in path',
      patch: fileDiff('package/utils/foo/files/etc/config/foo', []),
      files: {
        'package/utils/foo/Makefile': 'PKG_NAME:=foo\n',
        'package/utils/foo/files/etc/config/foo': 'invalid_line'
      }
    }
  ];

  for (const { name, patch, files } of rejected) {
    test(name, async () => {
      const res = await validateUciConfigs(patch, CONFIG, repo(files));
      assertErrorIncludes(res, NOT_UCI);
    });
  }

  const leftAlone = [
    // Regression: files sharing a base name with the package's config file
    // (uhttpd.acl vs uhttpd.config, both stem 'uhttpd') used to match the
    // /etc/config/uhttpd conffiles entry and be rejected as invalid UCI, even
    // though the Makefile installs them explicitly somewhere else entirely.
    {
      name: 'leaves alone a JSON sibling installed explicitly outside /etc/config',
      patch: fileDiff('package/network/services/uhttpd/files/uhttpd.acl', []),
      files: {
        'package/network/services/uhttpd/Makefile': [
          'PKG_NAME:=uhttpd',
          'define Package/uhttpd/conffiles',
          '/etc/config/uhttpd',
          '/etc/uhttpd.crt',
          'endef',
          '',
          'define Package/uhttpd/install',
          '\t$(INSTALL_CONF) ./files/uhttpd.config $(1)/etc/config/uhttpd',
          '\t$(INSTALL_DATA) ./files/uhttpd.capabilities $(1)/etc/capabilities/uhttpd.json',
          '\t$(INSTALL_DATA) ./files/uhttpd.acl $(1)/usr/share/acl.d/uhttpd.json',
          'endef'
        ].join('\n'),
        'package/network/services/uhttpd/files/uhttpd.acl': '{\n\t"user": "uhttpd"\n}\n'
      }
    },
    {
      name: 'ignores shell scripts and init scripts',
      patch: fileDiff('package/utils/foo/files/foo.init', []),
      files: {
        'package/utils/foo/Makefile': `
define Package/foo/install
\t$(INSTALL_BIN) ./files/foo.init $(1)/etc/init.d/foo
endef
        `,
        'package/utils/foo/files/foo.init': '#!/bin/sh\n/etc/rc.common\n'
      }
    },
    // The conffiles block lists /etc/config/foo, and the init script is named
    // foo too, yet it lives under files/etc/init.d/ and is no UCI file.
    {
      name: 'ignores init scripts under files/etc/init.d/ even when conffiles has a matching /etc/config/ entry',
      patch: fileDiff('net/foo/files/etc/init.d/foo', []),
      files: {
        'net/foo/Makefile': `
define Package/foo/conffiles
/etc/config/foo
endef

define Package/foo/install
\t$(INSTALL_BIN) ./files/etc/init.d/foo $(1)/etc/init.d/foo
\t$(INSTALL_CONF) ./files/etc/config/foo $(1)/etc/config/foo
endef
        `,
        'net/foo/files/etc/init.d/foo': '#!/bin/sh /etc/rc.common\n\nSTART=20\n',
        'net/foo/files/etc/config/foo': `config foo 'global'\n\toption enabled '1'\n`
      }
    },
    // Same conffiles entry, for a ucode library that is not under an etc/
    // subdirectory at all.
    {
      name: 'ignores ucode scripts under files/ that are not under files/etc/config/',
      patch: fileDiff('net/foo/files/lib/foo/foo.uc', []),
      files: {
        'net/foo/Makefile': `
define Package/foo/conffiles
/etc/config/foo
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/usr/lib/foo
\t$(INSTALL_DATA) ./files/lib/foo/foo.uc $(1)/usr/lib/foo/foo.uc
\t$(INSTALL_CONF) ./files/etc/config/foo $(1)/etc/config/foo
endef
        `,
        'net/foo/files/lib/foo/foo.uc': `'use strict';\n\n// helper functions\n`,
        'net/foo/files/etc/config/foo': `config foo 'global'\n\toption enabled '1'\n`
      }
    },
    {
      name: 'ignores sed scripts and defaults files',
      patch: fileDiff('package/utils/foo/files/foo.conf.sed', []) + fileDiff('package/utils/foo/files/foo.defaults', []),
      files: {
        'package/utils/foo/Makefile': `
define Package/foo/install
\t$(INSTALL_DATA) ./files/foo.conf.sed $(1)/usr/share/foo/foo.conf.sed
\t$(INSTALL_DATA) ./files/foo.defaults $(1)/etc/uci-defaults/foo
\t$(INSTALL_DATA) ./files/foo.conf $(1)/etc/config/foo
endef
        `,
        'package/utils/foo/files/foo.conf.sed': 's/a/b/\n',
        'package/utils/foo/files/foo.defaults': 'chown foo:foo /etc/foo.conf\n'
      }
    },
    {
      name: 'ignores configuration files installed to other locations (e.g. /etc/foo/)',
      patch: fileDiff('package/utils/foo/files/foo.conf', []),
      files: {
        'package/utils/foo/Makefile': `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo/foo.conf
endef
        `,
        'package/utils/foo/files/foo.conf': 'raw_config_key: raw_value\n'
      }
    }
  ];

  for (const { name, patch, files } of leftAlone) {
    test(name, async () => {
      const res = await validateUciConfigs(patch, CONFIG, repo(files));
      assertNoErrors(res);
    });
  }

  test('accepts valid UCI configurations (sections, options, lists, comments, empty lines)', async () => {
    const fetchFn = repo({
      'package/utils/foo/Makefile': `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo
endef
        `,
      'package/utils/foo/files/foo.config': `
# This is a comment
package 'foo'

config system 'main'
\toption hostname 'OpenWrt'

config timeserver 'ntp'
\tlist server '0.openwrt.pool.ntp.org'
\tlist server '1.openwrt.pool.ntp.org'
        `
    });
    const res = await validateUciConfigs(fileDiff('package/utils/foo/files/foo.config', []), CONFIG, fetchFn);
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'is a valid UCI configuration file', 'successes');
  });

  test('skips checks when check_uci_config is false', async () => {
    const fetchFn = repo({ 'package/utils/foo/files/etc/config/foo': 'invalid_line' });
    const disabledConfig = { ...CONFIG, check_uci_config: false };
    const res = await validateUciConfigs(fileDiff('package/utils/foo/files/etc/config/foo', []), disabledConfig, fetchFn);
    assertNoErrors(res);
  });
});
