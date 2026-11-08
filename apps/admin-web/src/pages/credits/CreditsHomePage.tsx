import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RequestsInbox } from '../../components/CreditRequests';
import { Badge, Card, ErrorText, PageHeader } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cr, OWNER_LABEL, type WalletSummary } from '../../lib/credits';

/** Entry point: the wallets you own or manage. */
export function CreditsHomePage() {
  const q = useQuery({
    queryKey: ['credits', 'mine'],
    queryFn: () => api<WalletSummary[]>('/credits/mine'),
  });
  return (
    <>
      <PageHeader title="Credits" subtitle="AI help is paid from these balances." />
      <ErrorText error={q.error ? errorMessage(q.error) : null} />
      {q.data?.length === 0 && (
        <Card>
          <p className="text-muted">You don't manage any credit wallets yet.</p>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {q.data?.map((w) => {
          // A teacher's / student's own wallet is funded by buying from AI Coach (Admin) with a UTR.
          const own = w.ownerType === 'user' && !!w.requestTo?.toAdmin;
          return (
            <Link
              key={w.id}
              to="/credits/wallets/$walletId"
              params={{ walletId: w.id }}
              className="rounded-2xl border border-border bg-surface p-5 hover:bg-surface-muted"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <Badge>{own ? 'My own credits' : OWNER_LABEL[w.ownerType]}</Badge>
                {!!w.pendingAcknowledgements && (
                  <Badge tone="warn">{w.pendingAcknowledgements} to confirm</Badge>
                )}
              </div>
              <p className="text-lg font-semibold">
                {own ? 'Paid by me, for my own use' : w.label}
              </p>
              <p className="mt-3 text-3xl font-bold">{cr(w.availableMicro)}</p>
              <p className="text-sm text-muted">available</p>
              <p className="mt-2 text-sm text-muted">
                Used in the last 30 days: {cr(w.consumed.last30dMicro)}
              </p>
              {own && <p className="mt-3 font-semibold text-primary">Buy credits →</p>}
            </Link>
          );
        })}
      </div>
      <div className="mt-6">
        <RequestsInbox title="Credit requests waiting for you" hideWhenEmpty />
      </div>
    </>
  );
}
