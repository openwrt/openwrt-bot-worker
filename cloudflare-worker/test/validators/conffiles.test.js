import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateMakefileContext } from '../../src/validators.js';
import {
  CONFIG, makeCommit, existingPackage, newPackage, diff, gitModified,
  assertSomeIncludes, assertNoErrors, assertErrorIncludes, assertNoErrorIncludes
} from './helpers.js';

const FOO = 'package/utils/foo/Makefile';

// One commit, in a pull request that has not added or dropped a package unless
// the given state says so.
const validate = (message, patch, state = existingPackage()) =>
  validateMakefileContext(makeCommit(message), patch, CONFIG, state);

describe('validateMakefileContext', () => {
  const MISSING_SECTION = "missing the required 'conffiles' section";
  // A newly added Makefile arrives whole, so a conffiles block missing from it is really missing.
  const newFooMakefile = (...lines) => diff(`diff --git a/${FOO} b/${FOO}`, 'new file mode 100644', '--- /dev/null', `+++ b/${FOO}`, lines);

  test('does not demand conffiles for non-config payload under /etc', () => {
    const res = validate('uhttpd: run in ujail', diff(
      gitModified('package/network/services/uhttpd/Makefile'),
      '+\t$(INSTALL_DIR) $(1)/etc/capabilities',
      '+\t$(INSTALL_DATA) ./files/uhttpd.capabilities $(1)/etc/capabilities/uhttpd.json',
      '+\t$(INSTALL_DIR) $(1)/usr/share/acl.d',
      '+\t$(INSTALL_DATA) ./files/uhttpd.acl $(1)/usr/share/acl.d/uhttpd.json'
    ));
    assertNoErrorIncludes(res, 'conffiles');
  });

  test('still demands conffiles for INSTALL_CONF and /etc/config destinations in a new Makefile', () => {
    for (const installLine of [
      '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/foo',
      '+\t$(CP) ./files/foo.config $(1)/etc/config/foo'
    ]) {
      const res = validate('foo: add new package', newFooMakefile(installLine), newPackage());
      assertSomeIncludes(res.errors, MISSING_SECTION, `errors for '${installLine.trim()}'`);
    }
  });

  test('does not demand conffiles when an existing Makefile only changes its install line', () => {
    const res = validate('foo: install the configuration with INSTALL_CONF', diff(
      gitModified(FOO),
      '@@ -120,7 +120,7 @@ define Package/foo/install',
      '-\t$(INSTALL_DATA) ./files/foo.conf $(1)/etc/foo.conf',
      '+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf'
    ));
    assertNoErrorIncludes(res, MISSING_SECTION);
  });

  test('rejects package that installs config files but is missing conffiles section', () => {
    const res = validate('foo: test', newFooMakefile(
      '+define Package/foo/install',
      '+\t$(INSTALL_DIR) $(1)/etc/config',
      '+\t$(INSTALL_DATA) ./files/foo.config $(1)/etc/config/foo',
      '+endef'
    ), newPackage());
    assertErrorIncludes(res, "Makefile installs configuration files under /etc/, but is missing the required 'conffiles' section");
  });

  // Diffs around a conffiles block that must pass as they are.
  for (const { title, patch } of [
    {
      title: 'ignores files that are not Makefiles even if they contain conffiles block definitions',
      patch: diff(gitModified('package/utils/foo/README.md'), '+define Package/foo/conffiles', '+    /etc/foo.json', '+endef')
    },
    {
      title: 'ignores deleted conffiles definitions when tracking state',
      patch: diff(
        gitModified(FOO),
        '-define Package/foo/conffiles',
        '-/etc/foo.json',
        '-endef',
        '+define Package/foo/install',
        '+\t$(INSTALL_DIR) $(1)/usr/bin',
        '+endef'
      )
    },
    {
      title: 'accepts an INSTALL_DIR directory written without a trailing slash',
      patch: diff(
        gitModified(FOO),
        '+define Package/foo/conffiles',
        '+/etc/foo.d',
        '+endef',
        '+define Package/foo/install',
        '+\t$(INSTALL_DIR) $(1)/etc/foo.d',
        '+endef'
      )
    },
    {
      title: 'closes conffiles block on a define that is not a conffiles block',
      patch: diff(
        gitModified('net/foo/Makefile'),
        '@@ -41,0 +42,6 @@ define Package/foo/conffiles',
        '+define Build/Configure',
        '+\t( cd $(PKG_BUILD_DIR) && autoreconf -fi )',
        '+\t$(call Build/Configure/Default)',
        '+endef',
        '+'
      )
    },
    {
      title: 'accepts package that installs config files and has conffiles section',
      patch: diff(
        gitModified(FOO),
        '+define Package/foo/conffiles',
        '+/etc/config/foo',
        '+endef',
        '+define Package/foo/install',
        '+\t$(INSTALL_DIR) $(1)/etc/config',
        '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo',
        '+endef'
      )
    },
  ]) {
    test(title, () => {
      assertNoErrors(validate('foo: test', patch));
    });
  }

  const INDENTED = 'must not contain any spaces or indentation';
  const RELATIVE = "must be an absolute path starting with '/'";
  const TRAILING_SLASH = 'must not end with a trailing slash';

  test('does not leak conffiles block into install block when endef is in diff hunk header', () => {
    const res = validate('foo: test', diff(
      gitModified(FOO),
      '@@ -50,6 +50,8 @@ endef',
      ' define Package/foo/conffiles',
      ' /etc/foo.conf',
      '+/etc/foo.d/',
      ' endef',
      ' ',
      ' define Package/foo/install',
      '+\t$(INSTALL_DIR) $(1)/etc/foo.d',
      '+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf',
      ' endef'
    ));
    // The install lines must not be judged as conffiles entries.
    assertNoErrorIncludes(res, 'INSTALL_DIR');
    assertNoErrorIncludes(res, 'INSTALL_CONF');
    assert.ok(!res.errors.some(e => e.includes(INDENTED) && e.includes('INSTALL')), `Should not flag install lines as indentation errors: ${res.errors.join(', ')}`);
  });

  test('does not leak conffiles block into a later install hunk when endef is never shown in the diff (odhcp6c PR#22751 regression)', () => {
    const res = validate('odhcp6c: test', diff(
      gitModified('package/network/ipv6/odhcp6c/Makefile'),
      '@@ -28,7 +28,7 @@ define Package/odhcp6c',
      '   SECTION:=net',
      '   CATEGORY:=Network',
      '   TITLE:=Embedded DHCPv6-client for OpenWrt',
      '-  DEPENDS:=@IPV6 +libubox +libubus',
      '+  DEPENDS:=@IPV6 +libubox +libubus +ucode',
      ' endef',
      '',
      ' define Package/odhcp6c/conffiles',
      '@@ -40,7 +40,7 @@ define Package/odhcp6c/install',
      ' \t$(INSTALL_DIR) $(1)/usr/sbin/',
      ' \t$(INSTALL_BIN) $(PKG_BUILD_DIR)/odhcp6c $(1)/usr/sbin/',
      ' \t$(INSTALL_DIR) $(1)/lib/netifd/proto',
      '-\t$(INSTALL_BIN) ./files/dhcpv6.sh $(1)/lib/netifd/proto/dhcpv6.sh',
      '+\t$(INSTALL_BIN) ./files/dhcpv6.uc $(1)/lib/netifd/proto/dhcpv6.uc',
      ' \t$(INSTALL_BIN) ./files/dhcpv6.script $(1)/lib/netifd/'
    ));
    for (const text of ['INSTALL_BIN', INDENTED, 'must be an absolute path']) assertNoErrorIncludes(res, text);
  });

  test('does not leak conffiles block into a later hunk whose context is not a define', () => {
    const res = validate('foo: bump to 3.0.722, replace maintainer', diff(
      gitModified('net/foo/Makefile'),
      '@@ -33,7 +33,7 @@ endef',
      ' define Package/foo/description',
      ' foo is a packet sniffer that runs as a background process on a cable/DSL',
      ' router, gathers all sorts of statistics about network usage, and serves them',
      '-over HTTP.',
      '+over HTTPS.',
      ' endef',
      '',
      ' define Package/foo/conffiles',
      '@@ -49,6 +49,11 @@ CONFIGURE_VARS += \\',
      ' \tac_cv_search_strlcpy=no \\',
      ' \tac_cv_search_strlcat=no',
      '',
      '+define Build/Configure',
      '+\t( cd $(PKG_BUILD_DIR) && autoreconf -fi )',
      '+\t$(call Build/Configure/Default)',
      '+endef',
      '+',
      ' define Build/Compile',
      ' \t$(HOSTCC) $(PKG_BUILD_DIR)/static/c-ify.c \\',
      ' \t\t-o $(PKG_BUILD_DIR)/c-ify'
    ));
    for (const text of ['Build/Configure', 'autoreconf', INDENTED, 'must be an absolute path']) assertNoErrorIncludes(res, text);
  });

  // What an entry may look like, judged by what the build does with it:
  // scripts/ipkg-build rewrites the first word of each line and hands the
  // list to find, and whatever package-pack.mk does not checksum as a regular
  // file goes to /lib/upgrade/keep.d, which sysupgrade expands with find.
  const conffilesBlock = (entries) =>
    validate('foo: test', diff(gitModified(FOO), '+define Package/foo/conffiles', entries.map(e => '+' + e), '+endef'));
  const conffilesErrorsFor = (entries) => conffilesBlock(entries).errors;

  test('accepts valid conffiles block with no indentation or space', () => {
    const res = conffilesBlock(['/etc/foo.json']);
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'conffiles block contains no spaces or indentation', 'successes');
  });

  // Blocks that must pass as they are.
  for (const { title, entries } of [
    {
      // `scripts/ipkg-build` and sysupgrade both hand the entry to `find`, which
      // walks a directory the same with or without the slash, and openwrt ships
      // `/etc/ipsec.d` next to `/etc/dnsmasq.d/`, so demanding one spelling
      // rejected valid Makefiles.
      title: 'accepts a conffiles directory written without a trailing slash',
      entries: ['/etc/config', '/etc/foo.conf', '/etc/foo.d']
    },
    {
      title: 'accepts conffiles .d directory with trailing slash',
      entries: ['/etc/foo.conf', '/etc/foo.d/']
    },
    {
      title: 'accepts conffiles directory with trailing slash',
      entries: ['/etc/config/', '/etc/ssl/certs/']
    },
    {
      title: 'accepts the make expansions openwrt writes in conffiles blocks',
      entries: [
        '$(CONF_DIR)/my.cnf',
        '$(config_directory)',
        '$(Package/busybox/conffiles/crond)',
        '$(call Package/tac_plus/Default/conffiles)',
        '$(if $(CONFIG_OPENSSL_ENGINE_BUILTIN_PADLOCK),/etc/ssl/modules.cnf.d/padlock.cnf)',
        '/etc/$(PKG_NAME).conf'
      ]
    },
    {
      // gkrellmd, openvpn-easy-rsa and prometheus-node-exporter-ucode write these
      title: 'accepts a literal path with an expansion in the middle or at the end',
      entries: ['/etc/$(PKG_NAME).conf', '/etc/profile.d/50-$(PKG_NAME).sh', '/etc/config/$(PKG_NAME)']
    },
    {
      // mariadb and postfix: the leading slash, if any, is decided at build time
      title: 'accepts a path that begins with an expansion',
      entries: ['$(CONF_DIR)/my.cnf', '$(config_directory)']
    },
    {
      title: 'accepts a whole-line make call, nested expansions and interior spaces included',
      entries: [
        '$(if $(CONFIG_OPENSSL_ENGINE_BUILTIN_PADLOCK),/etc/ssl/modules.cnf.d/padlock.cnf)',
        '$(call Package/tac_plus/Default/conffiles)',
        '$(call $(TARGET)/conffiles)',
        '$(Package/busybox/conffiles/crond)',
      ]
    },
    {
      // Anywhere on the line: one that begins with literal text would otherwise
      // be judged as a relative path.
      title: 'stays silent on an unterminated expansion, which make itself refuses',
      entries: ['$(unclosed/foo', 'etc$(unclosed/foo']
    },
  ]) {
    test(title, () => {
      assert.deepStrictEqual(conffilesErrorsFor(entries), []);
    });
  }

  // Each entry goes into a block of its own, so one cannot hide behind another's error.
  for (const { title, entries, errors } of [
    { title: 'rejects conffiles block with space indentation', entries: ['    /etc/foo.json'], errors: [INDENTED] },
    { title: 'rejects conffiles block with tab indentation', entries: ['\t/etc/foo.json'], errors: [INDENTED] },
    { title: 'rejects conffiles block with spaces inside a line', entries: ['/etc/foo.json '], errors: [INDENTED] },
    { title: 'rejects conffiles path that is not an absolute path', entries: ['etc/foo.json'], errors: [RELATIVE] },
    { title: 'still rejects an indented conffiles entry, expansion or not', entries: ['  $(CONF_DIR)/my.cnf'], errors: [INDENTED] },
    { title: 'rejects a relative path however many expansions follow it', entries: ['foo$(WHATEVER)'], errors: [RELATIVE] },
    { title: 'rejects two words on a line even when the second is an expansion', entries: ['not/a/path $(FOO)'], errors: [INDENTED, RELATIVE] },
    {
      title: 'rejects whitespace outside a call even when a call is present',
      entries: ['$(call Package/x/Default/conffiles) ', '/etc/a /etc/b', '/etc/a.conf $(B)'],
      errors: [INDENTED]
    },
    {
      // uboot-envtools indents with a tab, bluez-tools with two spaces
      title: 'rejects indentation with either whitespace character, expansion or not',
      entries: ['\t/etc/config/ubootenv', '  /etc/config/btagent', '  $(CONF_DIR)/my.cnf'],
      errors: [INDENTED]
    },
    { title: 'still rejects a trailing slash on an individual config file', entries: ['/etc/config/foo/'], errors: [TRAILING_SLASH] },
    {
      title: 'rejects conffiles path for individual file ending with trailing slash',
      entries: ['/etc/config/foo/'],
      errors: ['is an individual file and must not end with a trailing slash']
    },
    {
      title: 'rejects conffiles path for individual file with extension ending with trailing slash',
      entries: ['/etc/foo.conf/'],
      errors: ['is an individual file and must not end with a trailing slash']
    },
  ]) {
    test(title, () => {
      for (const entry of entries) {
        const found = conffilesErrorsFor([entry]);
        for (const text of errors) assertSomeIncludes(found, text, `errors for ${JSON.stringify(entry)}`);
      }
    });
  }

  test('rejects a trailing slash on a file even with an expansion in the path', () => {
    assertSomeIncludes(conffilesErrorsFor(['/etc/config/$(PKG_NAME)/']), TRAILING_SLASH, 'errors');
    assert.deepStrictEqual(conffilesErrorsFor(['/etc/dnsmasq.d/', '/etc/ipsec.d']), []);
  });

  test('accepts whitespace only as the separator after a make function name', () => {
    assert.deepStrictEqual(conffilesErrorsFor([
      '$(if $(filter y,$(CONFIG_X)),/etc/a.conf)',
      '${call Package/tac_plus/Default/conffiles}',
    ]), []);
    // Each of these puts whitespace into what the line expands to.
    for (const entry of ['$(if $(CONFIG_X),/etc/a /etc/b)', '$(foreach f,a b,/etc/$(f).conf)', '$(FOO BAR)/etc/x.conf', '$(if $(CONFIG_X), /etc/a)']) {
      assertSomeIncludes(conffilesErrorsFor([entry]), INDENTED, `errors for ${JSON.stringify(entry)}`);
    }
  });

  test('rejects a trailing slash on the file extensions the tree uses', () => {
    for (const entry of ['/etc/mysql/my.cnf/', '/etc/fw_env.config/', '/etc/nftables.d/10-custom.nft/', '/etc/firewall.user/']) {
      assertSomeIncludes(conffilesErrorsFor([entry]), TRAILING_SLASH, `errors for ${JSON.stringify(entry)}`);
    }
    assert.deepStrictEqual(conffilesErrorsFor(['/etc/nftables.d/', '/etc/luci-uploads/']), []);
  });
});
