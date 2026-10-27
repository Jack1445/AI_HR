export async function restoreRecycleRecords<T extends { id: string; name: string }>(
  rows: T[],
  restore: (id: string) => Promise<void>,
  onRestored: (id: string) => void,
  onProgress: (completed: number, total: number) => void,
) {
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  const failures: string[] = [];
  let restored = 0;
  onProgress(0, unique.length);
  for (const [index, row] of unique.entries()) {
    try { await restore(row.id); restored++; onRestored(row.id); }
    catch (error) { failures.push(`${row.name}：${error instanceof Error ? error.message : '操作失败'}`); }
    onProgress(index + 1, unique.length);
  }
  return { restored, failures };
}
