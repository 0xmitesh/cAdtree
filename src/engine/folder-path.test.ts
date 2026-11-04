import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbsoluteFolderPath, normalizeFolderPath, composeFilePaths } from '../utils/folder-path';
import { splitAndValidatePath, checkCaseInsensitiveCollisions } from './fs-adapter';

const location = { workspaceId: 'w', relativeDirectory: 'projects/Actuator/working/Case-A', filePath: 'Parts/工程/Bracket.SLDPRT' };
test('absolute syntax comes from the address and preserves Windows drive and UNC behaviour', () => {
  for (const [input, expected] of [
    ['  "d:/CAD Workspace/"  ', 'D:\\CAD Workspace'],
    ['C:/', 'C:\\'],
    ['\\\\server\\share\\', '\\\\server\\share'],
    ['\\\\server/share/CAD 工程', '\\\\server\\share\\CAD 工程'],
  ]) {
    assert.deepEqual(parseAbsoluteFolderPath(input), { path: expected, syntax: 'windows' });
    assert.equal(composeFilePaths(input, location).folder, expected.replace(/\\$/, '') + '\\projects\\Actuator\\working\\Case-A\\Parts\\工程');
  }
});

test('POSIX composition preserves case, Unicode and literal backslashes without Windows root restrictions', () => {
  for (const root of ['/Users/mitesh/Documents/Cadtree', '/home/mitesh/Documents/Cadtree', '/home/工程/Cafe\u0301', '/home/CON/aux:design?', '/home/Work\\Archive', '/home/$USER', '/home/Design folder ', '/home/工程\u00a0']) {
    assert.deepEqual(parseAbsoluteFolderPath(root + '/'), { path: root, syntax: 'posix' });
    assert.deepEqual(composeFilePaths(root, location), { file: `${root}/${location.relativeDirectory}/${location.filePath}`, folder: `${root}/${location.relativeDirectory}/Parts/工程` });
  }
  assert.equal(composeFilePaths('/', { ...location, filePath: 'Assembly.SLDASM' }).folder, '/' + location.relativeDirectory);
  assert.equal(normalizeFolderPath('"/home/Design folder "'), '/home/Design folder ');
  assert.equal(normalizeFolderPath(''), '');
});

test('absolute parsing rejects ambiguous, relative and expansion shorthand without changing managed relative validation', () => {
  for (const root of ['~/Cadtree', '$HOME/Cadtree', '${HOME}/Cadtree', '%USERPROFILE%\\Cadtree', 'C:Cadtree', '\\Cadtree', 'relative/folder', 'https://host/folder', 'file:///home/a', '//server/share', '/home/../a', '/home/./a', '/home//a', '/home/a\n', '\\\\server', '\\\\?\\C:\\a']) assert.throws(() => parseAbsoluteFolderPath(root), root);
  for (const filePath of ['../Part', '/Part', 'Parts\\Part', 'Parts/../Part', 'CON', 'Part.', 'Part ']) {
    assert.throws(() => composeFilePaths('/home/mitesh/Cadtree', { ...location, filePath }), filePath);
  }
  assert.deepEqual(splitAndValidatePath('Parts/工程/Cafe\u0301.SLDPRT'), ['Parts', '工程', 'Cafe\u0301.SLDPRT']);
  assert.equal(checkCaseInsensitiveCollisions(['Parts/A', 'parts/a']).length, 1);
});
