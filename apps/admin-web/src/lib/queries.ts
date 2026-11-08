import type { MeResponse, OfferingView } from '@aicoach/core';
import { useQuery } from '@tanstack/react-query';
import { api, ApiRequestError } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<MeResponse>('/me');
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 30_000,
  });
}

export function useOfferings() {
  return useQuery({
    queryKey: ['offerings'],
    queryFn: () => api<OfferingView[]>('/catalog/offerings'),
  });
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api<{ turnstileSiteKey: string }>('/config'),
    staleTime: Infinity,
  });
}
