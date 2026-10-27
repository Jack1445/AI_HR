import type { LocalCandidate, LocalCandidateListResponse } from './api';

export interface CommunicationProgress {
  total: number;
  completed: number;
  verified: number;
  classified: number;
  unknown: number;
  failed: number;
}
export interface CommunicationFailure { ids: string[]; names: string[]; error: string }
export interface CommunicationResult extends CommunicationProgress { failures: CommunicationFailure[] }

/** Use the IDs actually scanned in this sync, never the current page or all old snapshots. */
export function selectVerificationCandidates(people: LocalCandidate[], ids: string[]): LocalCandidate[] {
  if (!Array.isArray(ids)) throw new Error('同步结果缺少核验名单，请重启后端后重试');
  const byId = new Map(people.map(row => [row.id, row]));
  return [...new Set(ids)].map(id => {
    const person = byId.get(id);
    if (!person) throw new Error('本次同步的核验名单与本地数据不一致，请重新同步');
    return person;
  });
}

/** Each CLI call supports ten people. This is a batch size, never a total limit. */
export async function verifyCommunicationBatch(
  people: LocalCandidate[],
  verify: (ids: string[]) => Promise<LocalCandidateListResponse>,
  onSaved: (rows: LocalCandidate[]) => void,
  onProgress: (progress: CommunicationProgress) => void,
): Promise<CommunicationResult> {
  const unique = [...new Map(people.map(person => [person.id, person])).values()];
  const progress: CommunicationProgress = { total: unique.length, completed: 0, verified: 0, classified: 0, unknown: 0, failed: 0 };
  const failures: CommunicationFailure[] = [];
  onProgress({ ...progress });
  for (let offset = 0; offset < unique.length; offset += 10) {
    const batch = unique.slice(offset, offset + 10), ids = batch.map(person => person.id);
    try {
      const result = await verify(ids);
      const returned = new Set(result.candidates.map(row => row.id));
      if (result.total !== ids.length || result.candidates.length !== ids.length || returned.size !== ids.length || ids.some(id => !returned.has(id))) throw new Error('核验结果与本批候选人不一致');
      onSaved(result.candidates);
      const failed = result.candidates.filter(row => row.communication_evidence === null && row.communication_error);
      const known = result.candidates.filter(row => row.communication_status !== 'unknown').length;
      progress.verified += batch.length - failed.length;
      progress.classified += known;
      progress.unknown += batch.length - failed.length - known;
      progress.failed += failed.length;
      failures.push(...failed.map(row => ({ ids: [row.id], names: [row.name], error: row.communication_error })));
    } catch (reason) {
      progress.failed += batch.length;
      failures.push({ ids, names: batch.map(person => person.name), error: reason instanceof Error ? reason.message : '核验失败' });
    }
    progress.completed += batch.length;
    onProgress({ ...progress });
  }
  return { ...progress, failures };
}
