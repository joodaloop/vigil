// Day-by-day series as the API sends them: only the days with a value, as
// [day's index in the period, value], since most rows have none on most
// days. The dashboard turns them back into one value per day.
export type Sparse = [number, number][];

export const toSparse = (values: number[]): Sparse =>
    values.flatMap((v, i) => (v ? [[i, v] as [number, number]] : []));

export function toDense(series: Sparse, length: number): number[] {
    const values = Array<number>(length).fill(0);
    for (const [i, v] of series) values[i] = v;
    return values;
}
