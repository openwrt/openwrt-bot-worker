import { describe, test } from 'node:test';
import assert from 'node:assert';
import { findPkgRoot } from '../../src/validators.js';

describe('findPkgRoot', () => {
  test('ignores category-level Makefiles and non-package paths but parses package paths correctly', async () => {
    const CASES = [
      // Category level Makefiles should be ignored (return null)
      ['package/utils/Makefile', null],
      ['utils/Makefile', null],
      ['package/Makefile', null],
      ['Makefile', null],

      // Standard package directories
      ['package/utils/bash/Makefile', 'package/utils/bash'],
      ['package/utils/bash/src/main.c', 'package/utils/bash'],
      ['package/utils/bash/patches/001-fix.patch', 'package/utils/bash'],

      // Category-less package layout
      ['package/iozone/Makefile', 'package/iozone'],
      ['package/iozone/files/iozone.init', 'package/iozone'],

      // Normal feed layout
      ['utils/bash/Makefile', 'utils/bash'],

      // Deeply nested feed layouts (luci/libs/<pkg>)
      ['luci/libs/luci-lib-uqr/Makefile', 'luci/libs/luci-lib-uqr'],
      ['luci/libs/luci-lib-uqr/patches/001-fix.patch', 'luci/libs/luci-lib-uqr'],

      // Nested python, perl, php, ruby packages under lang/
      ['lang/python/python-selinux/Makefile', 'lang/python/python-selinux'],
      ['lang/python/python-selinux/patches/001-fix.patch', 'lang/python/python-selinux'],
      ['lang/python/python-selinux/src/subfolder/file.c', 'lang/python/python-selinux'],
      ['package/lang/python/python-selinux/Makefile', 'package/lang/python/python-selinux'],
      ['lang/python/Makefile', 'lang/python'],

      ['lang/perl/perl-libxml/Makefile', 'lang/perl/perl-libxml'],
      ['lang/php/php8-pecl-redis/Makefile', 'lang/php/php8-pecl-redis'],
      ['lang/ruby/ruby-sass-listen/Makefile', 'lang/ruby/ruby-sass-listen'],
      ['lang/lua/lua-foo/Makefile', 'lang/lua/lua-foo'],
      ['lang/lua/lua-foo/patches/001-fix.patch', 'lang/lua/lua-foo'],
      ['package/lang/lua/lua-foo/Makefile', 'package/lang/lua/lua-foo'],

      // Non-nested languages (e.g. golang)
      ['lang/golang/Makefile', 'lang/golang'],
      ['lang/golang/src/subfolder/file.c', 'lang/golang'],

      // Hidden directories and special folders
      ['.github/workflows/check.yml', null],
    ];
    for (const [path, expected] of CASES) {
      assert.strictEqual(await findPkgRoot(path, null), expected, `findPkgRoot(${JSON.stringify(path)}, null)`);
    }
  });

  test('resolves uncommon package category layout via Makefile fallback', async () => {
    const fetchFn = async (path) => {
      if (path === 'package/security/openssl/Makefile') {
        return 'PKG_NAME:=openssl\n';
      }
      return null;
    };

    assert.strictEqual(
      await findPkgRoot('package/security/openssl/files/openssl.conf', fetchFn, {}),
      'package/security/openssl'
    );
  });
});

describe('findPkgRoot for feeds without category directories', () => {
  const routingFetch = async (path) => {
    if (path === 'babeld/Makefile' || path === 'batman-adv/Makefile') {
      return 'PKG_NAME:=' + path.split('/')[0] + '\n';
    }
    return null;
  };

  test('resolves a routing feed package from its Makefile', async () => {
    assert.strictEqual(await findPkgRoot('babeld/Makefile', routingFetch, {}), 'babeld');
  });

  test('resolves a routing feed package from a nested file', async () => {
    assert.strictEqual(await findPkgRoot('batman-adv/files/etc/config/batman-adv', routingFetch, {}), 'batman-adv');
    assert.strictEqual(await findPkgRoot('babeld/patches/001-fix.patch', routingFetch, {}), 'babeld');
  });

  test('returns null for root directories that are not packages', async () => {
    assert.strictEqual(await findPkgRoot('scripts/dl_cleanup.py', async () => null, {}), null);
  });

  test('never guesses single-segment roots in dry mode (no fetch available)', async () => {
    assert.strictEqual(await findPkgRoot('scripts/dl_cleanup.py', null), null);
    assert.strictEqual(await findPkgRoot('babeld/Makefile', null), null);
    assert.strictEqual(await findPkgRoot('package/utils/bash/Makefile', null), 'package/utils/bash');
  });

  test('resolves video feed categories without probing', async () => {
    const noFetch = async () => { throw new Error('should not probe fast-path categories'); };
    assert.strictEqual(await findPkgRoot('frameworks/gstreamer1/Makefile', noFetch, {}), 'frameworks/gstreamer1');
    assert.strictEqual(await findPkgRoot('games/prboom/Makefile', noFetch, {}), 'games/prboom');
  });
});
