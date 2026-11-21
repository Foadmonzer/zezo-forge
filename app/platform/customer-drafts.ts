
import { fileValid, newKey, safeId } from './customer-data';

export type RequestDraft = {
  key: string; owner: string; step: number; service: string; category: string;
  template: string; action: string; details: string; budget: string; phone: string;
  consent: boolean; conversation: string; attachmentName: string; updated: number;
};

const draftKey = 'zezo-project-draft-v1';
const ageLimit = 24 * 60 * 60 * 1000;

export function newDraft(options: Partial<RequestDraft> = {}): RequestDraft {
  return {
    key: newKey(), owner: '', step: 0, service: '', category: '', template: '', action: 'order',
    details: '', budget: '', phone: '', consent: false, conversation: '', attachmentName: '',
    ...options, updated: Date.now(),
  };
}

export function readDraft(owner: string) {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey) || 'null') as RequestDraft | null;
    if (!draft || !safeId(draft.key) || (draft.owner && draft.owner !== owner)) return null;
    if (Date.now() - draft.updated > ageLimit) {
      clearDraft(draft.key);
      return null;
    }
    return draft;
  } catch { return null; }
}

export function saveDraft(draft: RequestDraft) {
  try { localStorage.setItem(draftKey, JSON.stringify({ ...draft, updated: Date.now() })); return true; }
  catch { return false; }
}

export function clearDraft(key: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(draftKey) || 'null') as RequestDraft | null;
    if (stored?.key === key) localStorage.removeItem(draftKey);
  } catch { /* Storage may be disabled. */ }
  void draftAttachment('delete', key).catch(() => undefined);
}

function openFiles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zezo-request-files-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function draftAttachment(action: 'get' | 'put' | 'delete', key: string, file?: File): Promise<File | null> {
  const database = await openFiles();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('files', action === 'get' ? 'readonly' : 'readwrite');
      const files = transaction.objectStore('files');
      const request = action === 'get' ? files.get(key) : action === 'delete' ? files.delete(key) : files.put(file, key);
      transaction.oncomplete = () => resolve(request.result instanceof File && fileValid(request.result) ? request.result : null);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
