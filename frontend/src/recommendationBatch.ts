import type { OnlineResumeScreenshot, RecommendedPerson } from './api';

export interface ResumeBatchProgress {
  total: number;
  completed: number;
  failed: number;
  currentName: string | null;
}

// Invoked only by the manual read button. Await each screenshot to avoid
// opening multiple resume panels in the shared BOSS browser at once.
export async function captureRecommendationBatch(
  people: RecommendedPerson[],
  capture: (person: RecommendedPerson) => Promise<OnlineResumeScreenshot>,
  onSaved: (person: RecommendedPerson, screenshot: OnlineResumeScreenshot) => void,
  onProgress: (progress: ResumeBatchProgress) => void,
): Promise<string[]> {
  if (people.length > 10) throw new Error('本次推荐人数超过 10 人，已停止批量截图');
  const failures: string[] = [];
  for (const [index, person] of people.entries()) {
    onProgress({ total: people.length, completed: index, failed: failures.length, currentName: person.name });
    try {
      if (!person.geekId) throw new Error('缺少候选人 ID，请重新读取列表');
      const screenshot = await capture(person);
      onSaved(person, screenshot);
    } catch (reason) {
      failures.push(`${person.name}：${reason instanceof Error ? reason.message : '截图失败，请重试'}`);
    }
    onProgress({ total: people.length, completed: index + 1, failed: failures.length, currentName: null });
  }
  onProgress({ total: people.length, completed: people.length, failed: failures.length, currentName: null });
  return failures;
}
