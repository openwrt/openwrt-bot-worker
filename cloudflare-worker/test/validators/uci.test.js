import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateUciConfigs } from '../../src/validators.js';
import { CONFIG } from './helpers.js';

describe('validateUciConfigs', () => {
  // Regression: files sharing a base name with the package's config file
  // (uhttpd.acl vs uhttpd.config, both stem 'uhttpd') used to match the
  // /etc/config/uhttpd conffiles entry and be rejected as invalid UCI, even
  // though the Makefile installs them explicitly somewhere else entirely.
  test('leaves alone a JSON sibling installed explicitly outside /etc/config', async () => {
    const uhttpdMakefile = [
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
    ].join('\n');
    const patch = `
diff --git a/package/network/services/uhttpd/files/uhttpd.acl b/package/network/services/uhttpd/files/uhttpd.acl
--- /dev/null
+++ b/package/network/services/uhttpd/files/uhttpd.acl
+{
+	"user": "uhttpd"
+}
`;
    const fetchFn = async (path) => {
      if (path === 'package/network/services/uhttpd/Makefile') return 'PKG_NAME:=uhttpd\n' + uhttpdMakefile;
      if (path === 'package/network/services/uhttpd/files/uhttpd.acl') return '{\n\t"user": "uhttpd"\n}\n';
      return null;
    };
    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('still validates a file whose explicit install line points at /etc/config', async () => {
    const makefile = [
      'PKG_NAME:=mypkg',
      'define Package/mypkg/install',
      '\t$(INSTALL_CONF) ./files/mypkg.json $(1)/etc/config/mypkg',
      'endef'
    ].join('\n');
    const patch = `
diff --git a/package/utils/mypkg/files/mypkg.json b/package/utils/mypkg/files/mypkg.json
--- /dev/null
+++ b/package/utils/mypkg/files/mypkg.json
+{ "not": "uci" }
`;
    const fetchFn = async (path) => {
      if (path === 'package/utils/mypkg/Makefile') return makefile;
      if (path === 'package/utils/mypkg/files/mypkg.json') return '{ "not": "uci" }\n';
      return null;
    };
    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes('not a valid UCI configuration file')), `Errors: ${res.errors.join(', ')}`);
  });

  test('accepts valid UCI configurations (sections, options, lists, comments, empty lines)', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.config b/package/utils/foo/files/foo.config
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.config
@@ -0,0 +1,10 @@
+# This is a comment
+package 'foo'
+
+config system 'main'
+\toption hostname 'OpenWrt'
+
+config timeserver 'ntp'
+\tlist server '0.openwrt.pool.ntp.org'
+\tlist server '1.openwrt.pool.ntp.org'
+    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.config') {
        return `
# This is a comment
package 'foo'

config system 'main'
\toption hostname 'OpenWrt'

config timeserver 'ntp'
\tlist server '0.openwrt.pool.ntp.org'
\tlist server '1.openwrt.pool.ntp.org'
        `;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('is a valid UCI configuration file')));
  });

  test('rejects raw TOML at etc/config path', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.toml b/package/utils/foo/files/foo.toml
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.toml
@@ -0,0 +1,5 @@
+[foo]
+enabled = true
+hostname = "OpenWrt"
+    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.toml $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.toml') {
        return `
[foo]
enabled = true
hostname = "OpenWrt"
        `;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes('not a valid UCI configuration file')), `Expected error, got: ${JSON.stringify(res.errors)}`);
  });

  test('identifies etc/config file via conffiles block', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.conf b/package/utils/foo/files/foo.conf
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.conf
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/conffiles
/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.conf') {
        // Not valid UCI
        return `invalid_key = "value"`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes("destined for '/etc/config/' but is not a valid UCI")), `Expected error, got: ${JSON.stringify(res.errors)}`);
  });

  test('ignores shell scripts and init scripts', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.init b/package/utils/foo/files/foo.init
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.init
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_BIN) ./files/foo.init $(1)/etc/init.d/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.init') {
        return `#!/bin/sh\n/etc/rc.common\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores init scripts under files/etc/init.d/ even when conffiles has a matching /etc/config/ entry', async () => {
    // Simulates a package where an init script at files/etc/init.d/foo
    // should NOT be flagged as a UCI config file even though the
    // Makefile conffiles block has /etc/config/foo.
    const patch = `
diff --git a/net/foo/files/etc/init.d/foo b/net/foo/files/etc/init.d/foo
new file mode 100644
--- /dev/null
+++ b/net/foo/files/etc/init.d/foo
    `;

    const fetchFn = async (path) => {
      if (path === 'net/foo/Makefile') {
        return `
define Package/foo/conffiles
/etc/config/foo
endef

define Package/foo/install
\t$(INSTALL_BIN) ./files/etc/init.d/foo $(1)/etc/init.d/foo
\t$(INSTALL_CONF) ./files/etc/config/foo $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'net/foo/files/etc/init.d/foo') {
        return `#!/bin/sh /etc/rc.common\n\nSTART=20\n`;
      }
      if (path === 'net/foo/files/etc/config/foo') {
        return `config foo 'global'\n\toption enabled '1'\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores ucode scripts under files/ that are not under files/etc/config/', async () => {
    // Simulates a package where a ucode library script at files/lib/foo/foo.uc
    // should NOT be flagged as a UCI config file even though the
    // Makefile conffiles block has /etc/config/foo.
    const patch = `
diff --git a/net/foo/files/lib/foo/foo.uc b/net/foo/files/lib/foo/foo.uc
new file mode 100644
--- /dev/null
+++ b/net/foo/files/lib/foo/foo.uc
    `;

    const fetchFn = async (path) => {
      if (path === 'net/foo/Makefile') {
        return `
define Package/foo/conffiles
/etc/config/foo
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/usr/lib/foo
\t$(INSTALL_DATA) ./files/lib/foo/foo.uc $(1)/usr/lib/foo/foo.uc
\t$(INSTALL_CONF) ./files/etc/config/foo $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'net/foo/files/lib/foo/foo.uc') {
        return `'use strict';\n\n// helper functions\n`;
      }
      if (path === 'net/foo/files/etc/config/foo') {
        return `config foo 'global'\n\toption enabled '1'\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores sed scripts and defaults files', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.conf.sed b/package/utils/foo/files/foo.conf.sed
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.conf.sed
diff --git a/package/utils/foo/files/foo.defaults b/package/utils/foo/files/foo.defaults
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.defaults
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_DATA) ./files/foo.conf.sed $(1)/usr/share/foo/foo.conf.sed
\t$(INSTALL_DATA) ./files/foo.defaults $(1)/etc/uci-defaults/foo
\t$(INSTALL_DATA) ./files/foo.conf $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.conf.sed') {
        return `s/a/b/\n`;
      }
      if (path === 'package/utils/foo/files/foo.defaults') {
        return `chown foo:foo /etc/foo.conf\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores configuration files installed to other locations (e.g. /etc/foo/)', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.conf b/package/utils/foo/files/foo.conf
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.conf
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo/foo.conf
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.conf') {
        return `raw_config_key: raw_value\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('directly recognizes files with /etc/config/ in path', async () => {
    const patch = `
diff --git a/package/utils/foo/files/etc/config/foo b/package/utils/foo/files/etc/config/foo
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/etc/config/foo
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return 'PKG_NAME:=foo\n';
      }
      if (path === 'package/utils/foo/files/etc/config/foo') {
        return 'invalid_line';
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes("destined for '/etc/config/' but is not a valid UCI")));
  });

  test('skips checks when check_uci_config is false', async () => {
    const patch = `
diff --git a/package/utils/foo/files/etc/config/foo b/package/utils/foo/files/etc/config/foo
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/etc/config/foo
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/files/etc/config/foo') {
        return 'invalid_line';
      }
      return null;
    };

    const disabledConfig = { ...CONFIG, check_uci_config: false };
    const res = await validateUciConfigs(patch, disabledConfig, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });
});
