import { Link } from '@tanstack/react-router';
import { navFor } from '../components/Layout';
import { Card, PageHeader } from '../components/ui';
import { useMe } from '../lib/queries';

export function HomePage() {
  const { data: me } = useMe();
  if (!me) return null;
  const sections = navFor(me);

  if (me.user.role === 'student') {
    return (
      <>
        <PageHeader title={`Hi ${me.user.name}`} />
        <Card>
          <p>
            Learning journeys are in the AI Coach mobile app. This web workspace is for admins,
            institutions and teachers.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={`Welcome, ${me.user.name}`} subtitle="Choose where to work" />
      {sections.length === 0 ? (
        <Card>
          <p className="text-muted">
            Nothing is assigned to you yet. A class teacher is added to a class by their
            institution's POC; an institution POC is added by an Admin.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.flatMap((s) =>
            s.items.map((item) => (
              <Link
                key={s.section + item.label}
                to={item.to}
                params={item.params as never}
                className="rounded-2xl border border-border bg-surface p-5 hover:bg-surface-muted"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {s.section}
                </p>
                <p className="text-lg font-semibold">{item.label}</p>
              </Link>
            )),
          )}
        </div>
      )}
    </>
  );
}
