import { formatInr } from '@aicoach/core';

/** Wallet money (micro-INR) → "₹1,234.50". Everything users see is in rupees. */
export const cr = (micro: number | null | undefined) => (micro == null ? '—' : formatInr(micro));

/** Provider cost (nano-USD) → "$0.000123". Admin-only screens. */
export const usd = (nano: number | null | undefined, digits = 6) =>
  nano == null ? '—' : `$${(nano / 1e9).toFixed(digits)}`;

/** Where "Request credits" goes from a wallet. */
export type RequestTo = { toAdmin: boolean; label: string } | null;

export interface WalletSummary {
  id: string;
  ownerType: 'platform' | 'institution' | 'class' | 'user';
  label: string;
  parentWalletId: string | null;
  balanceMicro: number;
  heldMicro: number;
  availableMicro: number;
  dailyCapMicro: number | null;
  consumed: { last24hMicro: number; last30dMicro: number; totalMicro: number; calls: number };
  pendingAcknowledgements?: number;
  requestTo?: RequestTo;
}

export interface AllotmentView {
  id: string;
  direction: 'in' | 'out';
  from: { id: string | null; label: string };
  to: { id: string; label: string };
  amountMicro: number;
  status: 'open' | 'locked';
  note: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  lockedAt: string | null;
  edits: { oldAmountMicro: number; newAmountMicro: number; reason: string | null; at: string }[];
  can: { edit: boolean; lock: boolean; acknowledge: boolean };
}

export interface WalletDetail {
  wallet: WalletSummary;
  requestTo: RequestTo;
  parent: { id: string; label: string } | null;
  children: WalletSummary[];
  allotments: AllotmentView[];
  breakdown: {
    byTask: { key: string; billed: number; calls: number }[];
    byModel: { key: string; billed: number; raw: number; calls: number }[] | null;
  };
  recentUsage: {
    id: string;
    createdAt: string;
    task: string;
    model: string | null;
    status: 'ok' | 'error';
    billedMicro: number;
    rawUsdNano: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheStatus: string;
    userName: string | null;
  }[];
  can: { manage: boolean; receive: boolean; allotToChildren: boolean; drillDown: boolean };
}

export const OWNER_LABEL: Record<WalletSummary['ownerType'], string> = {
  platform: 'Platform',
  institution: 'Institution',
  class: 'Class',
  user: 'Person',
};

export const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export interface CreditRequestView {
  id: string;
  wallet: { id: string; label: string };
  parentWalletId: string;
  to: string;
  toAdmin: boolean;
  requester: { name: string | null; email: string | null };
  amountMicro: number;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  grantedMicro: number | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  payment: {
    reference: string | null;
    method: string;
    paidOn: string;
    amountMinor: number;
    status: 'pending' | 'verified' | 'rejected';
  } | null;
  can: { decide: boolean; cancel: boolean };
}

export const METHOD_LABEL: Record<string, string> = {
  upi: 'UPI',
  bank_transfer: 'Bank transfer (NEFT/IMPS/RTGS)',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
