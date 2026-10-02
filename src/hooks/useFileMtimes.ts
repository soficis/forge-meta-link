import { useQuery } from "@tanstack/react-query";
import { getFileMtimes, getFileMtimesForQuery } from "../services/commands";

export function useFileMtimes(clusterQuery?: string | null, limit = 50000) {
    const normalized = (clusterQuery ?? "").trim();
    const hasQuery = normalized.length > 0;
    return useQuery({
        queryKey: ["fileMtimes", hasQuery ? normalized : "__all__", limit],
        queryFn: () => hasQuery ? getFileMtimesForQuery(normalized, limit) : getFileMtimes(limit, 0),
        staleTime: 30_000,
        gcTime: 120_000,
    });
}
