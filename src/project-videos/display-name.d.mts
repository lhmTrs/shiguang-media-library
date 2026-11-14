export function episodeFilePrefix(seriesName: string, seasonNo: number | null, episodeNo: number): string | null;
export function prefixForProject(
  project: {series_id?: string | null; season_id?: string | null; episode_no?: number | null} | undefined | null,
  seriesList: {id: string; name: string; seasons?: {id: string; season_no: number}[]}[] | undefined | null,
): string | null;
export function shortVideoName(name: string, prefix?: string | null): string;
