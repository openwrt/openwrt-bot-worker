import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateConffilesCoverage, validateMakefileContext } from '../../src/validators.js';
import {
  CONFIG, makeCommit, existingPackage, newPackage, diff, gitModified,
  assertNoneIncludes,
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

  test('does not demand conffiles when an existing Makefile only changes its install line and no fetcher is provided', () => {
    const res = validate('foo: install the configuration with INSTALL_CONF', diff(
      gitModified(FOO),
      '@@ -120,7 +120,7 @@ define Package/foo/install',
      '-\t$(INSTALL_DATA) ./files/foo.conf $(1)/etc/foo.conf',
      '+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf'
    ));
    assertNoErrorIncludes(res, MISSING_SECTION);
  });

  test('verifies conffiles in head Makefile when existing Makefile introduces INSTALL_CONF', async () => {
    const patch = diff(
      gitModified(FOO),
      '@@ -120,7 +120,7 @@ define Package/foo/install',
      '-\t$(INSTALL_DATA) ./files/foo.conf $(1)/etc/foo.conf',
      '+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf'
    );

    // 1. When the head Makefile has no conffiles section: the pull request did
    // not write that Makefile, it only starts installing configuration from a
    // recipe that was already there, so the missing block is not its doing.
    // Demanding one here turns such a pull request red on lines nobody in it
    // wrote - across the feeds, on every package that adds an INSTALL_CONF.
    const headWithoutConffiles = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
endef
`;
    const resWithout = await validateMakefileContext(makeCommit('foo: install conf'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headWithoutConffiles);
    assertNoErrorIncludes(resWithout, MISSING_SECTION);

    // 2. When head Makefile DOES have conffiles section:
    const headWithConffiles = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/foo.conf
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
endef
`;
    const resWith = await validateMakefileContext(makeCommit('foo: install conf'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headWithConffiles);
    assertNoErrorIncludes(resWith, MISSING_SECTION);
    assertSomeIncludes(resWith.successes, 'conffiles macro properly registers INSTALL_CONF');

    // 3. When head Makefile has conffiles section, but it does NOT list the newly installed config file:
    const headWithMismatchedConffiles = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/oldfile.conf
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
endef
`;
    const resMismatched = await validateMakefileContext(makeCommit('foo: install conf'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headWithMismatchedConffiles);
    assert.ok(resMismatched.errors.some(e => e.includes("Makefile installs '/etc/foo.conf', but 'define Package/foo/conffiles' does not list it")));
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

  test('rejects config file installed by subpackage when conffiles block belongs only to another subpackage', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo-utils/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/foo-utils.conf $(1)/etc/foo-utils.conf
`;
    const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/foo.conf
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
endef

define Package/foo-utils
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo utilities
endef

define Package/foo-utils/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo-utils.conf $(1)/etc/foo-utils.conf
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: update utils'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.ok(res.errors.some(e => e.includes("missing the required 'conffiles' section for package 'foo-utils'")));
  });

  test('correctly identifies subpackage from hunk header context in diff of existing Makefile', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -35,3 +35,4 @@ define Package/foo-utils/install
 \t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/foo-utils.conf $(1)/etc/foo-utils.conf
`;
    const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/foo.conf
endef

define Package/foo-utils
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo utilities
endef

define Package/foo-utils/conffiles
/etc/other.conf
endef

define Package/foo-utils/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo-utils.conf $(1)/etc/foo-utils.conf
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: add config to utils'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.ok(res.errors.some(e => e.includes("Makefile installs '/etc/foo-utils.conf', but 'define Package/foo-utils/conffiles' does not list it")));
  });

  test('accepts conffiles coverage through variable expansion like $(CONF_DIR)/my.cnf', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/my.cnf $(1)/etc/my.cnf
`;
    const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
$(CONF_DIR)/my.cnf
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/my.cnf $(1)/etc/my.cnf
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: install my.cnf'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.deepStrictEqual(res.errors, []);
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  test('accepts conffiles coverage through embedded macro calls like $(call ...)', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/shared.conf $(1)/etc/shared.conf
`;
    const headMakefile = `
define Package/foo/Default/conffiles
/etc/shared.conf
endef

define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
$(call Package/foo/Default/conffiles)
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/shared.conf $(1)/etc/shared.conf
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: install shared.conf'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.deepStrictEqual(res.errors, []);
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  test('accepts conffiles coverage when install target uses variables like $(CONF_DIR) or $(config_directory)', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/my.cnf $(1)$(CONF_DIR)/my.cnf
`;
    const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/my.cnf
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/my.cnf $(1)$(CONF_DIR)/my.cnf
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: install my.cnf'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.deepStrictEqual(res.errors, []);
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  test('marks conffiles validation as incomplete when install target path cannot be safely determined', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/my.cnf $(1)/$(DYNAMIC_DEST)/my.cnf
`;
    const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/my.cnf
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: install dynamic dest'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.strictEqual(res.incomplete, true);
    assert.ok(!res.successes.some(s => s.includes('conffiles macro properly registers INSTALL_CONF')));
    assert.ok(res.notices.some(w => w.includes('Could not safely determine installed configuration path(s)')));
  });

  // The hunk around an install line often names no package: git's funcname
  // context can be blank, or an `ifeq` from inside the recipe. The head
  // Makefile does say which recipe the line sits in, so coverage is judged
  // against that package - not against whichever block happens to be the only
  // one, and not against the directory name.
  const utilsConfPatch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -40,3 +40,3 @@
-\t$(INSTALL_DATA) ./files/utils.conf $(1)/etc/utils.conf
+\t$(INSTALL_CONF) ./files/utils.conf $(1)/etc/utils.conf
`;
  const twoPackageMakefile = (installingPkg) => `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo-utils
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo Utils
endef

define Package/foo-utils/conffiles
/etc/utils.conf
endef

define Package/${installingPkg}/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/utils.conf $(1)/etc/utils.conf
endef
`;

  test('credits the conffiles block of the subpackage whose install recipe holds the line', async () => {
    const res = await validateMakefileContext(makeCommit('foo: install utils conf'), utilsConfPatch, CONFIG, existingPackage(), 'openwrt/packages', async () => twoPackageMakefile('foo-utils'));
    assertNoErrorIncludes(res, 'conffiles');
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  test('does not credit a conffiles block belonging to another subpackage than the one installing the file', async () => {
    const res = await validateMakefileContext(makeCommit('foo: install utils conf'), utilsConfPatch, CONFIG, existingPackage(), 'openwrt/packages', async () => twoPackageMakefile('foo'));
    assert.ok(res.errors.some(e => e.includes("missing the required 'conffiles' section for package 'foo'")), `errors: ${JSON.stringify(res.errors)}`);
    assert.ok(!res.successes.some(s => s.includes('conffiles macro properly registers INSTALL_CONF')));
  });

  test('infers installed filename when INSTALL_CONF target is a directory like $(1)/etc/ or $(1)/etc/config/', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/
+`;
    const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/foo.conf
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/etc
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: install foo.conf into /etc/'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(res.incomplete, false);
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  test('resolves $(PKG_NAME) in INSTALL_CONF target against headMakefile when not present in diff hunk', async () => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -40,2 +40,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc/config
+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/$(PKG_NAME)
+`;
    const headMakefile = `
PKG_NAME:=foo

define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/config/foo
endef
`;
    const res = await validateMakefileContext(makeCommit('foo: install config'), patch, CONFIG, existingPackage(), 'openwrt/packages', async () => headMakefile);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(res.incomplete, false);
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  test('ignores deleted conffiles entries in diff when validating conffiles coverage', () => {
    const res = validate('foo: replace config path', newFooMakefile(
      ' define Package/foo/conffiles',
      '-/etc/foo.conf',
      '+/etc/other.conf',
      ' endef',
      '+define Package/foo/install',
      '+\t$(INSTALL_DIR) $(1)/etc',
      '+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf',
      '+endef'
    ));
    assert.ok(res.errors.some(e => e.includes("Makefile installs '/etc/foo.conf', but 'define Package/foo/conffiles' does not list it")));
  });

  // `define Package/$(PKG_NAME)/conffiles` is the ordinary spelling across the
  // feeds (prometheus-node-exporter-ucode, asterisk, yate). A define name that
  // stopped at '(' captured `Package/$`, so the block was invisible and a
  // Makefile that has one was told to add one.
  test('reads a conffiles block whose define name is a make expansion', () => {
    const res = validate('foo: add new package', newFooMakefile(
      '+PKG_NAME:=foo',
      '+',
      '+define Package/$(PKG_NAME)/conffiles',
      '+/etc/config/foo',
      '+endef',
      '+',
      '+define Package/$(PKG_NAME)/install',
      '+\t$(INSTALL_DIR) $(1)/etc/config',
      '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo',
      '+endef'
    ), newPackage());
    // check_pkg_name_reuse still asks for the literal name here; what must not
    // happen is the blocking claim that the block is missing.
    assertNoErrorIncludes(res, MISSING_SECTION);
    assertNoErrorIncludes(res, 'does not list it');
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
  });

  // `define Package/$(PKG_NAME)/install` is how the feeds write a recipe, and
  // the expansion is no reason to accept the union of every conffiles block in
  // the Makefile: resolved against PKG_NAME the line installs for `foo`, and
  // `foo` has no block - only the sub-package `foo-extra` has one. Written as
  // `define Package/foo/install` the same Makefile reported it all along.
  test('resolves a make expansion in the install recipe instead of crediting any block', () => {
    const res = validate('foo: add new package', newFooMakefile(
      '+PKG_NAME:=foo',
      '+',
      '+define Package/foo',
      '+  TITLE:=Foo',
      '+endef',
      '+',
      '+define Package/foo-extra',
      '+  TITLE:=Foo extra',
      '+endef',
      '+',
      '+define Package/foo-extra/conffiles',
      '+/etc/config/foo',
      '+endef',
      '+',
      '+define Package/$(PKG_NAME)/install',
      '+\t$(INSTALL_DIR) $(1)/etc/config',
      '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo',
      '+endef'
    ), newPackage());
    assertErrorIncludes(res, "missing the required 'conffiles' section for package 'foo'");
  });

  // A name the Makefile's own variables cannot settle is still judged against
  // every block, but the error names the recipe the install line sits in.
  // Naming whichever block came first in the map told the contributor to add
  // the path to a package their line has nothing to do with.
  test('names the install recipe, not the first block, when the package stays unsettled', () => {
    const res = validate('foo: install the other config', diff(
      gitModified(FOO),
      '@@ -30,0 +31,4 @@ define Package/foo-extra',
      '+define Package/foo-extra/conffiles',
      '+/etc/config/extra',
      '+endef',
      '@@ -60,2 +69,3 @@ define Package/$(PKG_NAME)/install',
      '+\t$(INSTALL_DIR) $(1)/etc/config',
      '+\t$(INSTALL_CONF) ./files/other.config $(1)/etc/config/other'
    ));
    assertErrorIncludes(res, "'define Package/$(PKG_NAME)/conffiles' does not list it");
    assertNoErrorIncludes(res, "'define Package/foo-extra/conffiles' does not list it");
  });

  test('still demands the block when a make expansion names a package with none', () => {
    const res = validate('foo: add new package', newFooMakefile(
      '+PKG_NAME:=foo',
      '+',
      '+define Package/$(PKG_NAME)/install',
      '+\t$(INSTALL_DIR) $(1)/etc/config',
      '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo',
      '+endef'
    ), newPackage());
    assertErrorIncludes(res, MISSING_SECTION);
  });

  // What a glob or a directory source installs cannot be read off the
  // Makefile, so the installed set is unknown - not equal to the destination
  // directory. Reporting it as the directory asked for '/etc/config/' to be
  // listed verbatim, which no Makefile does (luci-app-olsrd2 installs
  // ./root/etc/config/*).
  for (const [what, source] of [['a glob', './root/etc/config/*'], ['a directory', './files/etc/config/.']]) {
    test(`does not demand a conffiles entry for the destination directory when the source is ${what}`, () => {
      const res = validate('foo: add new package', newFooMakefile(
        '+define Package/foo/conffiles',
        '+/etc/config/foo',
        '+endef',
        '+',
        '+define Package/foo/install',
        '+\t$(INSTALL_DIR) $(1)/etc/config',
        `+\t$(INSTALL_CONF) ${source} $(1)/etc/config/`,
        '+endef'
      ), newPackage());
      assertNoErrorIncludes(res, 'does not list it');
      assertNoErrorIncludes(res, MISSING_SECTION);
    });
  }

  // Without a diff driver git picks any line starting with a letter, '_' or
  // '$' as the funcname context, so an `ifeq` written at column 0 inside an
  // install recipe becomes the context of the next hunk. Throwing the package
  // away there sent the entry to the directory name.
  test('keeps the install package across a hunk whose funcname context is an ifeq', () => {
    const res = validate('foo: install the extra config under a config switch', diff(
      gitModified(FOO),
      '@@ -30,0 +31,8 @@ define Package/foo-extra',
      '+define Package/foo-extra/conffiles',
      '+/etc/config/extra',
      '+endef',
      '+',
      '+define Package/foo-other/conffiles',
      '+/etc/config/other',
      '+endef',
      '@@ -50,2 +59,2 @@ define Package/foo-extra/install',
      ' \t$(INSTALL_DIR) $(1)/etc/config',
      '@@ -60,2 +69,3 @@ ifeq ($(CONFIG_FOO_EXTRA),y)',
      '+\t$(INSTALL_CONF) ./files/extra.config $(1)/etc/config/extra',
      ' endif'
    ), existingPackage());
    assertNoErrorIncludes(res, MISSING_SECTION);
    assertNoErrorIncludes(res, 'does not list it');
  });

  // A Makefile may define no package named after its directory at all, and the
  // install line's own recipe may be outside the diff window. The single-block
  // rescue used to need the Makefile to define exactly one package too.
  test('judges coverage against the packages the Makefile defines, not the directory name', () => {
    const res = validate('foo: install the server config', diff(
      gitModified(FOO),
      '@@ -10,0 +11,10 @@',
      '+define Package/foo-server',
      '+  TITLE:=Foo server',
      '+endef',
      '+',
      '+define Package/foo-client',
      '+  TITLE:=Foo client',
      '+endef',
      '+',
      '+define Package/foo-server/conffiles',
      '+/etc/config/foo',
      '+endef',
      '@@ -50,2 +61,3 @@',
      '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo',
      ' endef'
    ), existingPackage());
    assertNoErrorIncludes(res, MISSING_SECTION);
    assertNoErrorIncludes(res, 'does not list it');
  });

  // Reading every source off the line means reading its options too, and only
  // install's mode, owner and group take a value: `cp -r` does not, so the
  // flag must not swallow the file after it and leave the bare directory.
  for (const flags of ['-r', '-a', '-m 0600', '-m0600', '-p -r']) {
    test(`resolves the installed file through install options '${flags}'`, () => {
      const res = validate('foo: add new package', newFooMakefile(
        '+define Package/foo/conffiles',
        '+/etc/config/foo.config',
        '+endef',
        '+',
        '+define Package/foo/install',
        '+\t$(INSTALL_DIR) $(1)/etc/config',
        `+\t$(CP) ${flags} ./files/foo.config $(1)/etc/config/`,
        '+endef'
      ), newPackage());
      assertNoErrorIncludes(res, 'does not list it');
      assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF');
    });
  }

  // A conffiles entry whose path is made of make expansions used to become one
  // unbounded regex group per expansion. Groups cannot cross '/', so a path
  // that does not match sent the engine through every way of splitting a path
  // segment between them: seconds of CPU on a Makefile a contributor writes,
  // and with it a webhook killed at the 10 ms limit before any check-run is
  // posted. The install line below never matches, which is what made the
  // engine enumerate.
  const unresolvedEntryPatch = (entry, installedDir) => newFooMakefile(
    '+define Package/foo/conffiles',
    '+' + entry,
    '+endef',
    '+define Package/foo/install',
    `+\t$(INSTALL_CONF) ./files/x $(1)/etc/config/${installedDir}/x`,
    '+endef'
  );

  // Ten expansions side by side against a 35-character segment: ~3.5 s
  // unfixed, which is why the length is 35 and not more. The verdict is
  // unchanged, so what is pinned here is the time.
  test('judges adjacent unresolved expansions without enumerating the segment', () => {
    const entry = '/etc/config/' + Array.from({ length: 10 }, (_, i) => `$(A${i})`).join('');
    const started = Date.now();
    const res = validate('foo: add new package', unresolvedEntryPatch(entry, 'a'.repeat(35)), newPackage());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `judging one conffiles entry took ${elapsed} ms`);
    assertErrorIncludes(res, 'does not list it');
  });

  // Collapsing the adjacent ones is not the whole story: three expansions kept
  // apart by literal text survive it, and against a long segment that is 1.2 s
  // unfixed. A path segment's length is bounded by nothing in a patch.
  test('judges unresolved expansions separated by literals against a long path', () => {
    const started = Date.now();
    const res = validate('foo: add new package', unresolvedEntryPatch('/etc/config/$(A)x$(B)x$(C)', 'x'.repeat(2000)), newPackage());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `judging one conffiles entry took ${elapsed} ms`);
    assertErrorIncludes(res, 'does not list it');
  });

  test('reports an entry of four unresolved expansions as unchecked, not as missing', () => {
    const res = validate('foo: add new package', unresolvedEntryPatch('/etc/config/$(A)x$(B)x$(C)x$(D)', 'abcd'), newPackage());
    assertNoErrorIncludes(res, 'does not list it');
    assertSomeIncludes(res.notices, 'Could not verify', 'notices');
    assert.strictEqual(res.incomplete, true);
    // An unchecked path is no confirmation that the block is complete.
    assertNoneIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF', 'successes');
  });

  // Passes before the fix as well as after: the one expansion the feeds
  // actually write must still cover the path it stands for.
  test('still credits an entry whose single unresolved expansion covers the path', () => {
    const res = validate('foo: add new package', newFooMakefile(
      '+define Package/foo/conffiles',
      '+/etc/config/$(PKG_NAME)',
      '+endef',
      '+define Package/foo/install',
      '+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo',
      '+endef'
    ), newPackage());
    assertNoErrorIncludes(res, 'does not list it');
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF', 'successes');
  });

  // The cap on unresolved runs is there for runs competing over the
  // characters of one path segment. Counted across the whole entry it also
  // refused an entry that names one expansion per segment - unambiguous, and
  // linear to judge - so a correct Makefile's check went neutral.
  test('judges an entry whose every segment holds one unresolved expansion', () => {
    const res = validate('foo: add new package', newFooMakefile(
      '+define Package/foo/conffiles',
      '+/etc/$(D1)/$(D2)/$(D3)/$(D4)',
      '+endef',
      '+define Package/foo/install',
      '+\t$(INSTALL_CONF) ./files/x $(1)/etc/config/sub/one/two',
      '+endef'
    ), newPackage());
    assertNoErrorIncludes(res, 'does not list it');
    assertNoneIncludes(res.notices, 'Could not verify', 'notices');
    assert.strictEqual(res.incomplete, false);
    assertSomeIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF', 'successes');
  });

  // Each expansion of a run was a group that never matched an empty string, so
  // '$(A)$(B)' needs two characters. Collapsing the pair into one unknown run
  // dropped that and started covering a one-character name. The second entry
  // carries the shortfall into the walk along the segment: the '-' after the
  // run has to be looked for two characters in, not one.
  test('holds a run of adjacent expansions to one character per expansion', () => {
    const entryPatch = (entry, installed) => newFooMakefile(
      '+define Package/foo/conffiles',
      '+' + entry,
      '+endef',
      '+define Package/foo/install',
      `+\t$(INSTALL_CONF) ./files/x $(1)/etc/config/${installed}`,
      '+endef'
    );
    for (const [entry, tooShort, longEnough] of [
      ['/etc/config/$(A)$(B)', 'a', 'ab'],
      ['/etc/config/$(A)$(B)-$(C).conf', 'a-b.conf', 'ab-c.conf']
    ]) {
      assertErrorIncludes(validate('foo: add new package', entryPatch(entry, tooShort), newPackage()), 'does not list it');
      const covered = validate('foo: add new package', entryPatch(entry, longEnough), newPackage());
      assertNoErrorIncludes(covered, 'does not list it');
      assertSomeIncludes(covered.successes, 'conffiles macro properly registers INSTALL_CONF', `successes for '${entry}'`);
    }
  });

  // The two timing cases above never reach the segment matcher: their install
  // path carries one segment more than the entry, so the segment counts settle
  // it first. Here the counts are equal and the matcher really walks a
  // 2000-character segment, which the backtracking pattern spent ~1.4 s on.
  test('walks a long path segment against the literals between expansions', () => {
    const started = Date.now();
    const res = validate('foo: add new package', newFooMakefile(
      '+define Package/foo/conffiles',
      '+/etc/config/$(A)x$(B)x$(C)q',
      '+endef',
      '+define Package/foo/install',
      `+\t$(INSTALL_CONF) ./files/x $(1)/etc/config/${'x'.repeat(2000)}`,
      '+endef'
    ), newPackage());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `judging one conffiles entry took ${elapsed} ms`);
    assertErrorIncludes(res, 'does not list it');
  });

  // Only the source next to $(1) used to be resolved, so every earlier one on
  // the line went unchecked while the line still reported a pass.
  test('checks every source on an install line with more than one', () => {
    const res = validate('foo: add new package', newFooMakefile(
      '+define Package/foo/conffiles',
      '+/etc/config/second',
      '+endef',
      '+',
      '+define Package/foo/install',
      '+\t$(INSTALL_DIR) $(1)/etc/config',
      '+\t$(INSTALL_CONF) ./files/first ./files/second $(1)/etc/config/',
      '+endef'
    ), newPackage());
    assert.ok(res.errors.some(e => e.includes("Makefile installs '/etc/config/first'")), `errors: ${JSON.stringify(res.errors)}`);
    assertNoneIncludes(res.successes, 'conffiles macro properly registers INSTALL_CONF', 'successes');
  });
});

describe('validateConffilesCoverage', () => {
  // Every install line is paired with every conffiles entry, and reading an
  // entry - tokenising it and cutting it into segments - was redone for each
  // pair, so one entry's whole text went through the tokeniser once per
  // install line. Reading it depends on nothing but the entry, so it happens
  // once per entry now.
  //
  // Pinned as a ratio rather than a bound in milliseconds: the same entries are
  // judged against one install line and against a hundred, and reading them
  // once makes the two cost about the same, while reading them per pair makes
  // the second a hundred times the first. A ratio survives a loaded machine,
  // where an absolute bound close enough to the unfixed cost to discriminate
  // (3 ms fixed against 26 ms unfixed) is a flake.
  const judge = (entries, installed) => {
    const errors = [];
    validateConffilesCoverage(new Map([['foo', entries]]), installed, 'foo', errors, [], new Set(['foo']), true, []);
    return errors;
  };
  // Best of three: the first call also pays for compiling these functions,
  // which is several times what the pairing costs.
  const costOf = (entries, installed) => {
    let best = Infinity;
    let errors = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      errors = judge(entries, installed);
      best = Math.min(best, performance.now() - started);
    }
    return { best, errors };
  };

  test('reads a conffiles entry once, not once per install line', () => {
    const entries = new Set();
    for (let i = 0; i < 20; i++) {
      entries.add(`/etc/config/pre${i}${'z'.repeat(32000)}$(A)q${'z'.repeat(32000)}`);
    }
    const one = [{ pkg: 'foo', path: '/etc/config/other0' }];
    const hundred = [];
    for (let i = 0; i < 100; i++) hundred.push({ pkg: 'foo', path: `/etc/config/other${i}` });

    const single = costOf(entries, one);
    const many = costOf(entries, hundred);

    // No entry covers any of the paths, so every pair really is judged.
    assert.strictEqual(single.errors.length, 1);
    assert.strictEqual(many.errors.length, 100);
    assert.ok(many.best < single.best * 10 + 5,
      `100 install lines cost ${many.best.toFixed(1)} ms against ${single.best.toFixed(1)} ms for one: the entries are being read per pair`);
  });

  // A conffiles entry that is a literal path, and an install destination that
  // is one, are what nearly every Makefile in the feeds holds, and pairing
  // them one by one is quadratic: a patch can carry as many of each as it
  // likes, and 400 of each already cost more than the whole Worker CPU
  // budget. Each of the questions asked of an entry's own text holds only
  // when the entry is the install path or the join of a prefix of its
  // segments, so the path's own prefixes are looked up among the entries
  // instead. `reads` counts how often the set of entries is iterated: once
  // for the whole pairing now, once per install line before.
  test('looks an install path up among the entries instead of walking them', () => {
    class CountingSet extends Set {
      constructor() { super(); this.reads = 0; }
      [Symbol.iterator]() { this.reads++; return super[Symbol.iterator](); }
    }
    const entries = new CountingSet();
    for (let i = 0; i < 1500; i++) entries.add(`/etc/config/entry${i}`);
    const installed = [];
    for (let i = 0; i < 1500; i++) installed.push({ pkg: 'foo', path: `/etc/config/other${i}` });

    const errors = [];
    validateConffilesCoverage(new Map([['foo', entries]]), installed, 'foo', errors, [], new Set(['foo']), true, []);

    // No entry lists any of the paths, so every one of them is really judged.
    assert.strictEqual(errors.length, 1500);
    // The read count is the whole pin and it needs no clock: 1 when the set is
    // read once for the pairing, 1500 when it is read per install line.
    assert.strictEqual(entries.reads, 1, `the entries were read ${entries.reads} times`);
  });

  // Only an entry that still holds a make expansion needs the segment
  // matcher, and the tokeniser keeps no variable names, so entries that
  // differ only in which variable they name are one shape to it. Without
  // that, 600 such entries against 600 install lines is 360000 segment walks
  // instead of 600; a sub-package per configuration file writes exactly this.
  //
  // Pinned as a ratio, like the case above and for the same reason: the same
  // 600 install lines are judged against one entry and against 600 of its
  // shape, and collapsing them to one shape makes the two cost about the same,
  // while a shape per entry makes the second 600 times the first. Both arms
  // inflate together on a loaded machine, which is what an absolute bound in
  // milliseconds cannot do - that bound went red in most contended runs.
  test('matches one shape for entries that differ only in the variable named', () => {
    const sameShape = (count) => {
      const entries = new Set();
      for (let i = 0; i < count; i++) entries.add(`/etc/config/$(UNSET${i})x`);
      return entries;
    };
    const installed = [];
    for (let i = 0; i < 600; i++) installed.push({ pkg: 'foo', path: `/etc/config/other${i}` });

    const single = costOf(sameShape(1), installed);
    const many = costOf(sameShape(600), installed);

    // No entry covers any of the paths, so every pair really is judged.
    assert.strictEqual(single.errors.length, 600);
    assert.strictEqual(many.errors.length, 600);
    assert.ok(many.best < single.best * 10 + 5,
      `600 entries of one shape cost ${many.best.toFixed(1)} ms against ${single.best.toFixed(1)} ms for one: each entry is its own matcher shape`);
  });

  // Passes before the lookup above as well: it is the guard that replacing
  // the three string tests on each entry with a walk of the install path's
  // own prefixes admits exactly the same entries, trailing slash, bare root,
  // relative path and partial segment included.
  test('credits a directory entry for a path installed under it, and only then', () => {
    const judge = (entry, path) => {
      const errors = [];
      validateConffilesCoverage(new Map([['foo', new Set([entry])]]), [{ pkg: 'foo', path }], 'foo', errors, [], new Set(['foo']), true, []);
      return errors.length === 0;
    };
    for (const [entry, path] of [
      ['/etc/config', '/etc/config/foo'],
      ['/etc/config/', '/etc/config/foo'],
      ['/etc', '/etc/config/foo/bar'],
      ['/', '/etc/config/foo'],
      ['/etc/config/foo', '/etc/config/foo'],
      ['etc/config', 'etc/config/foo'],
    ]) assert.ok(judge(entry, path), `'${entry}' should cover '${path}'`);
    for (const [entry, path] of [
      ['/etc/config/fo', '/etc/config/foo'],
      ['/etc/config/foo', '/etc/config/foobar'],
      ['/etc/config/foo/bar', '/etc/config/foo'],
      ['/etc/other', '/etc/config/foo'],
    ]) assert.ok(!judge(entry, path), `'${entry}' should not cover '${path}'`);
  });
});
