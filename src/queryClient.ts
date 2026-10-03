import { QueryClient } from "@tanstack/react-query";

/** The app-wide React Query client. Lives in its own module so tests can reset its cache. */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});
