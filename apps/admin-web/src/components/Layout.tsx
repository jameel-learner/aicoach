import { ROLE_LABELS, type MeResponse } from '@aicoach/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { authClient } from '../lib/auth-client';

interface NavItem {
  to: string;
  label: string;
  params?: Record<string, string>;
}

export function navFor(me: MeResponse): { section: string; items: NavItem[] }[] {
  const sections: { section: string; items: NavItem[] }[] = [];
  if (me.user.role === 'admin') {
    sections.push({
      section: 'Admin',
      items: [
        { to: '/admin/institutions', label: 'Institutions' },
        { to: '/admin/taxonomy', label: 'Boards & subjects' },
        { to: '/admin/users', label: 'Users' },
        { to: '/admin/credits', label: 'Credits & payments' },
        { to: '/admin/models', label: 'AI models' },
        { to: '/credits', label: 'Wallets' },
        { to: '/playground', label: 'AI playground' },
      ],
    });
  }
  if (me.pocInstitutions.length) {
    sections.push({
      section: 'Institution',
      items: me.pocInstitutions.map((i) => ({
        to: '/institutions/$institutionId',
        params: { institutionId: i.id },
        label: i.name,
      })),
    });
    // Teachers already get a Credits link under Teaching.
    if (me.user.role !== 'teacher') {
      sections.push({
        section: 'Institution credits',
        items: [{ to: '/credits', label: 'Credits' }],
      });
    }
  }
  if (me.user.role === 'teacher') {
    sections.push({
      section: 'Teaching',
      items: [
        { to: '/teacher', label: 'My classes' },
        { to: '/credits', label: 'Credits' },
        { to: '/playground', label: 'AI playground' },
      ],
    });
  }
  return sections;
}

export function Layout({ me }: { me: MeResponse }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sections = navFor(me);

  async function signOut() {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: '/login' });
  }

  const nav = (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {sections.map((s) => (
        <div key={s.section}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {s.section}
          </p>
          <ul className="flex flex-col gap-1">
            {s.items.map((item) => (
              <li key={item.label}>
                <Link
                  to={item.to}
                  params={item.params as never}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2 hover:bg-surface-muted"
                  activeProps={{ className: 'bg-surface-muted font-semibold' }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:flex">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
        <Link to="/" className="font-bold">
          AI Coach
        </Link>
        <button
          className="min-h-11 rounded-lg border border-border px-3"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          Menu
        </button>
      </header>
      {open && <div className="border-b border-border bg-surface p-4 md:hidden">{nav}</div>}

      <aside className="hidden w-64 shrink-0 flex-col justify-between border-r border-border bg-surface p-4 md:flex">
        <div>
          <Link to="/" className="mb-8 block text-xl font-bold">
            AI Coach
          </Link>
          {nav}
        </div>
        <div className="text-sm">
          <p className="font-semibold">{me.user.name}</p>
          <p className="text-muted">{ROLE_LABELS[me.user.role]}</p>
          <button
            className="mt-2 font-semibold text-primary underline"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
        <Outlet />
        <div className="mt-10 border-t border-border pt-4 text-sm md:hidden">
          {me.user.name} · {ROLE_LABELS[me.user.role]} ·{' '}
          <button className="font-semibold text-primary underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </main>
    </div>
  );
}
