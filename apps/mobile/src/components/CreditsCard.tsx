import { formatInr } from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '../lib/api';
import { Body, Button, Card, Choice, ErrorText, Heading, TextField } from './ui';

interface WalletSummary {
  id: string;
  ownerType: 'platform' | 'institution' | 'class' | 'user';
  label: string;
  availableMicro: number;
  consumed: { last30dMicro: number };
  pendingAcknowledgements: number;
  /** Where "Request credits" goes: the teacher/institution, or Admin (needs the payment UTR). */
  requestTo: { toAdmin: boolean; label: string } | null;
}
interface Allotment {
  id: string;
  direction: 'in' | 'out';
  from: { label: string };
  amountMicro: number;
  can: { acknowledge: boolean };
}
interface CreditRequest {
  id: string;
  wallet: { id: string };
  to: string;
  amountMicro: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  grantedMicro: number | null;
  decisionNote: string | null;
  createdAt: string;
  payment: { reference: string | null } | null;
  can: { cancel: boolean };
}

const STATUS_TEXT: Record<CreditRequest['status'], string> = {
  pending: 'Waiting for a reply',
  approved: 'Accepted',
  rejected: 'Not accepted',
  cancelled: 'Cancelled',
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Me tab: my balances (₹), confirm received allotments, ask for more and see the replies. */
export function CreditsCard() {
  const qc = useQueryClient();
  const wallets = useQuery({
    queryKey: ['credits', 'mine'],
    queryFn: () => api<WalletSummary[]>('/credits/mine'),
  });
  const requests = useQuery({
    queryKey: ['credits', 'requests'],
    queryFn: () => api<CreditRequest[]>('/credits/requests?scope=mine'),
  });
  const own = (wallets.data ?? []).filter((w) => w.ownerType === 'user');
  if (!own.length) return null;
  return (
    <Card>
      <Heading>My credits</Heading>
      {own.map((w) => (
        <WalletRow
          key={w.id}
          w={w}
          requests={(requests.data ?? []).filter((r) => r.wallet.id === w.id)}
          onChange={() => void qc.invalidateQueries({ queryKey: ['credits'] })}
        />
      ))}
      <ErrorText error={wallets.error ? errorMessage(wallets.error) : null} />
    </Card>
  );
}

function WalletRow({
  w,
  requests,
  onChange,
}: {
  w: WalletSummary;
  requests: CreditRequest[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [method, setMethod] = useState<'upi' | 'bank_transfer'>('upi');
  const [paidOn, setPaidOn] = useState(today());
  const toAdmin = !!w.requestTo?.toAdmin;
  const detail = useQuery({
    queryKey: ['credits', 'wallet', w.id],
    queryFn: () => api<{ allotments: Allotment[] }>(`/credits/wallets/${w.id}`),
    enabled: w.pendingAcknowledgements > 0,
  });
  const ack = useMutation({
    mutationFn: (id: string) =>
      api(`/credits/allotments/${id}/acknowledge`, { method: 'POST', body: {} }),
    onSuccess: onChange,
  });
  const request = useMutation({
    mutationFn: () =>
      api('/credits/requests', {
        method: 'POST',
        body: {
          walletId: w.id,
          credits: amount,
          payment: toAdmin ? { reference: utr, method, paidOn } : undefined,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setAmount('');
      setUtr('');
      onChange();
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/credits/requests/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: onChange,
  });
  const toConfirm = (detail.data?.allotments ?? []).filter((a) => a.can.acknowledge);
  const pending = requests.find((r) => r.status === 'pending');
  const recent = requests.slice(0, 3);
  const error = [ack.error, request.error, cancel.error].find(Boolean);

  return (
    <View style={{ gap: 8, paddingTop: 8 }}>
      <Body>
        {w.label.replace(/\s*\(.*\)\s*/, ' ').trim()} · <Body>{formatInr(w.availableMicro)}</Body>{' '}
        available
      </Body>
      <Body muted>Used in the last 30 days: {formatInr(w.consumed.last30dMicro)}</Body>
      {toConfirm.map((a) => (
        <View key={a.id} style={{ gap: 6 }}>
          <Body>
            Received {formatInr(a.amountMicro)} from {a.from.label}. Is that right?
          </Body>
          <Button
            title="Confirm received"
            onPress={() => ack.mutate(a.id)}
            loading={ack.isPending}
          />
        </View>
      ))}

      {recent.map((r) => (
        <View key={r.id} style={{ gap: 4 }}>
          <Body muted>
            You asked {r.to} for {formatInr(r.amountMicro)}
            {r.payment?.reference ? ` (UTR ${r.payment.reference})` : ''}: {STATUS_TEXT[r.status]}
            {r.status === 'approved' && r.grantedMicro != null
              ? `, ${formatInr(r.grantedMicro)} added`
              : ''}
            {r.decisionNote ? `. “${r.decisionNote}”` : ''}
          </Body>
          {r.can.cancel && (
            <Button title="Cancel request" variant="link" onPress={() => cancel.mutate(r.id)} />
          )}
        </View>
      ))}

      {w.requestTo && !pending && !open && (
        <Button
          title={toAdmin ? 'I have paid: add credits' : 'Request credits'}
          variant="link"
          onPress={() => setOpen(true)}
        />
      )}
      {open && w.requestTo && (
        <View style={{ gap: 10 }}>
          <Body muted>
            {toAdmin
              ? 'Pay AI Coach by UPI or bank transfer, then enter the amount and the UTR. Admin checks it and adds the credits.'
              : `Your request goes to ${w.requestTo.label}.`}
          </Body>
          <TextField
            label={toAdmin ? 'Amount paid (₹)' : 'Amount (₹)'}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />
          {toAdmin && (
            <>
              <TextField
                label="UTR / transaction reference"
                hint="The 12-digit UTR shown in your UPI app"
                autoCapitalize="characters"
                value={utr}
                onChangeText={setUtr}
              />
              <Choice
                label="Paid by"
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'upi', label: 'UPI' },
                  { value: 'bank_transfer', label: 'Bank transfer' },
                ]}
              />
              <TextField label="Paid on (YYYY-MM-DD)" value={paidOn} onChangeText={setPaidOn} />
            </>
          )}
          <Button
            title={toAdmin ? 'Submit payment' : 'Send request'}
            onPress={() => request.mutate()}
            loading={request.isPending}
            disabled={!amount || (toAdmin && !utr)}
          />
          <Button title="Cancel" variant="link" onPress={() => setOpen(false)} />
        </View>
      )}
      <ErrorText error={error ? errorMessage(error) : null} />
    </View>
  );
}
