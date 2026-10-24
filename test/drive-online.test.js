import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWindowsDriveRoot,
  isDriveRootAccessible,
  shouldSkipMissingDeletion,
  partitionByDriveOnline
} from '../lib/drive-online.js';

describe('drive-online', () => {
  it('parses Windows drive roots', () => {
    assert.equal(getWindowsDriveRoot('P:\\Photos\\a.jpg'), 'P:\\');
    assert.equal(getWindowsDriveRoot('p:/x'), 'P:\\');
    assert.equal(getWindowsDriveRoot('D:\\NAS_Sync\\Share\\x'), 'D:\\');
    assert.equal(getWindowsDriveRoot('\\\\server\\share\\x'), null);
    assert.equal(getWindowsDriveRoot('/tmp/x'), null);
    assert.equal(getWindowsDriveRoot(''), null);
  });

  it('treats C:\\ as accessible on Windows when present', () => {
    const ok = isDriveRootAccessible('C:\\Windows');
    // On the DESKTOP machine C: exists; on Linux CI this returns true (no drive letter skip)
    assert.equal(typeof ok, 'boolean');
    if (process.platform === 'win32') {
      assert.equal(isDriveRootAccessible('C:\\'), true);
    }
  });

  it('shouldSkipMissingDeletion is false for online C: and true for absurd drive', async () => {
    if (process.platform !== 'win32') {
      assert.equal(shouldSkipMissingDeletion('/tmp/x'), false);
      return;
    }
    assert.equal(shouldSkipMissingDeletion('C:\\Windows\\explorer.exe', { log: () => {} }), false);
    // Z: is often unused; if somehow mounted, skip assertion
    const skip = shouldSkipMissingDeletion('Z:\\nope\\missing.jpg', { log: () => {} });
    const zOnline = isDriveRootAccessible('Z:\\');
    assert.equal(skip, !zOnline);
  });

  it('partitionByDriveOnline skips offline drive letter paths', async () => {
    if (process.platform !== 'win32') {
      const r = await partitionByDriveOnline(['/tmp/a'], { log: () => {} });
      assert.equal(r.online.length, 1);
      return;
    }
    const items = [
      { path: 'C:\\Windows\\explorer.exe' },
      { path: 'Z:\\fake\\offline.jpg' }
    ];
    const r = await partitionByDriveOnline(items, { log: () => {}, timeoutMs: 1500 });
    assert.ok(r.online.some(i => i.path.startsWith('C:')));
    const zOnline = isDriveRootAccessible('Z:\\');
    if (!zOnline) {
      assert.ok(r.skippedOffline.some(i => i.path.startsWith('Z:')));
    }
  });
});
