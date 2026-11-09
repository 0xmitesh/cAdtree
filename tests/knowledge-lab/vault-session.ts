import { splitAndValidatePath, type FileSystemDirectoryAdapter } from '../../src/engine/fs-adapter';
import { openExistingVault } from '../../src/engine/vault-service';
import { createKnowledgeRecord, KnowledgePublicationError, type CreateKnowledgeRecordInput } from '../../src/knowledge/records';
import { readOnlyDirectory, resolveVaultPath } from './load-vault';

/** Extra development-only capability boundary: writes can only append under knowledge/. */
function knowledgeWrites(directory: FileSystemDirectoryAdapter, prefix: string[] = []): FileSystemDirectoryAdapter {
  const assertPath = (path: string[]) => {
    const complete = [...prefix, ...path];
    splitAndValidatePath(complete.join('/'));
    if (complete[0] !== 'knowledge') throw new Error('Knowledge Lab cannot write outside the vault knowledge folder.');
  };
  return new Proxy(directory, { get(target, key) {
    if (key === 'name' || key === 'kind') return target[key];
    if (key === 'getDirectory') return async (path: string[], options?: { create?: boolean; exclusiveCreate?: boolean; exclusiveCheck?: boolean }) => {
      if (options?.create || options?.exclusiveCreate || options?.exclusiveCheck) assertPath(path);
      return knowledgeWrites(await target.getDirectory(path, options), [...prefix, ...path]);
    };
    if (['writeFileText', 'writeFileBytes', 'writeFileStream'].includes(String(key))) return (path: string[], ...args: unknown[]) => {
      assertPath(path); return Reflect.get(target, key).call(target, path, ...args);
    };
    if (key === 'removeEntry') return () => { throw new Error('Knowledge Lab never deletes vault data.'); };
    if (['listEntries', 'hasFile', 'hasDirectory', 'statFile', 'readFileStream', 'readFileBytes', 'readFileText'].includes(String(key))) return Reflect.get(target, key).bind(target);
    return undefined;
  } });
}

let nextSession = 1;

/** Ephemeral authorization only. No handles, flags or permanent metadata are saved. */
export class KnowledgeVaultSession {
  readonly instanceId = nextSession++;
  private enabled = false;
  private closed = false;
  private saving = false;
  private constructor(private readonly vault: FileSystemDirectoryAdapter, readonly projectId: string, readonly projectName: string, readonly destination: string) {}

  static async inspect(directory: FileSystemDirectoryAdapter) {
    const path = await resolveVaultPath(directory);
    const vault = await directory.getDirectory(path, { create: false });
    const state = await openExistingVault(readOnlyDirectory(vault));
    const session = new KnowledgeVaultSession(vault, state.project.projectId, state.project.name,
      [directory.name, ...path, 'knowledge'].join('/'));
    return { session, state };
  }

  get writeEnabled() { return this.enabled && !this.closed; }
  disableWrites() { this.enabled = false; }
  close() { if (this.saving) throw new Error('Wait for the active save before closing this vault.'); this.closed = true; this.enabled = false; }
  private assertOpen() { if (this.closed) throw new Error('This vault session is closed. Select the vault again.'); }

  async reload() {
    this.assertOpen();
    const state = await openExistingVault(readOnlyDirectory(this.vault));
    this.assertOpen();
    if (state.project.projectId !== this.projectId) { this.disableWrites(); throw new Error('The selected vault project changed. Close and select the vault again.'); }
    return state;
  }

  async authorizeDisposable(confirmed: boolean) {
    this.assertOpen(); this.disableWrites();
    if (!confirmed) throw new Error('Confirm that this destination is a disposable test vault before enabling writes.');
    // Request directly from the deliberate click, before asynchronous reconstruction.
    const permission = await this.vault.requestPermission('readwrite');
    this.assertOpen();
    if (permission !== 'granted') throw new Error('Write permission was not granted. Inspection remains read-only.');
    await this.reload();
    this.enabled = true;
  }

  async create(input: Omit<CreateKnowledgeRecordInput, 'projectId' | 'recordId'>) {
    this.assertOpen();
    if (!this.writeEnabled) throw new Error('This vault is read-only. Select a disposable test vault and explicitly enable writes.');
    if (this.saving) throw new Error('A knowledge save is already in progress.');
    this.saving = true;
    let publishedId: string | undefined;
    try {
      if (await this.vault.queryPermission('readwrite') !== 'granted') throw new Error('Write permission was revoked. Inspection remains read-only.');
      this.assertOpen();
      if (!this.writeEnabled) throw new Error('Write authorization was withdrawn before saving.');
      const published = await createKnowledgeRecord(knowledgeWrites(this.vault), { ...input, projectId: this.projectId });
      publishedId = published.record.recordId;
      const state = await this.reload();
      const reconstructed = state.knowledge?.records.find(r => r.record.recordId === publishedId);
      if (!reconstructed || reconstructed.source.recordSha256 !== published.source.recordSha256) throw new Error('The saved record could not be confirmed by reconstruction.');
      return { state, recordId: publishedId };
    } catch (error) {
      this.disableWrites();
      const reason = error instanceof Error ? error.message : String(error);
      const uncertainId = error instanceof KnowledgePublicationError ? error.recordId : undefined;
      throw new Error(`${reason}${publishedId ? ` Record ${publishedId} was already published.` : uncertainId ? ` Publication of record ${uncertainId} is unconfirmed.` : ''} Reload and inspect the vault before enabling writes or retrying.`);
    } finally { this.saving = false; }
  }
}
