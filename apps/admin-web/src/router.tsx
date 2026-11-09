import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { useMe } from './lib/queries';
import { AdminCreditsPage } from './pages/admin/AdminCreditsPage';
import { InstitutionsPage } from './pages/admin/InstitutionsPage';
import { ModelsPage } from './pages/admin/ModelsPage';
import { BookPage } from './pages/admin/BookPage';
import { BooksPage } from './pages/admin/BooksPage';
import { TaxonomyPage } from './pages/admin/TaxonomyPage';
import { UsersPage } from './pages/admin/UsersPage';
import { AuthPage } from './pages/AuthPage';
import { HomePage } from './pages/HomePage';
import { InstitutionPage } from './pages/InstitutionPage';
import { CreditsHomePage } from './pages/credits/CreditsHomePage';
import { WalletPage } from './pages/credits/WalletPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { ClassStudentsPage, TeacherClassesPage } from './pages/TeacherPages';

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4 text-muted">{children}</div>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: function Login() {
    const { data: me, isLoading } = useMe();
    if (isLoading) return <Centered>Loading…</Centered>;
    if (me) return <Navigate to="/" />;
    return <AuthPage />;
  },
});

/** Signed-in shell. The API enforces every permission; the UI only hides what you can't use. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: function AppShell() {
    const { data: me, isLoading, error } = useMe();
    if (isLoading) return <Centered>Loading…</Centered>;
    if (error) return <Centered>Could not reach the server. Please retry.</Centered>;
    if (!me) return <Navigate to="/login" />;
    return <Layout me={me} />;
  },
});

const parent = { getParentRoute: () => appRoute };
const homeRoute = createRoute({ ...parent, path: '/', component: HomePage });
const adminInstitutionsRoute = createRoute({
  ...parent,
  path: '/admin/institutions',
  component: InstitutionsPage,
});
const adminTaxonomyRoute = createRoute({
  ...parent,
  path: '/admin/taxonomy',
  component: TaxonomyPage,
});
const adminUsersRoute = createRoute({ ...parent, path: '/admin/users', component: UsersPage });
const institutionRoute = createRoute({
  ...parent,
  path: '/institutions/$institutionId',
  component: InstitutionPage,
});
const teacherRoute = createRoute({ ...parent, path: '/teacher', component: TeacherClassesPage });
const adminCreditsRoute = createRoute({
  ...parent,
  path: '/admin/credits',
  component: AdminCreditsPage,
});
const adminModelsRoute = createRoute({ ...parent, path: '/admin/models', component: ModelsPage });
const adminBooksRoute = createRoute({ ...parent, path: '/admin/books', component: BooksPage });
const adminBookRoute = createRoute({
  ...parent,
  path: '/admin/books/$bookId',
  component: BookPage,
});
const creditsRoute = createRoute({ ...parent, path: '/credits', component: CreditsHomePage });
const walletRoute = createRoute({
  ...parent,
  path: '/credits/wallets/$walletId',
  component: WalletPage,
});
const playgroundRoute = createRoute({ ...parent, path: '/playground', component: PlaygroundPage });
const classRoute = createRoute({
  ...parent,
  path: '/classes/$classId',
  component: ClassStudentsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    homeRoute,
    adminInstitutionsRoute,
    adminTaxonomyRoute,
    adminUsersRoute,
    institutionRoute,
    teacherRoute,
    classRoute,
    adminCreditsRoute,
    adminModelsRoute,
    adminBooksRoute,
    adminBookRoute,
    creditsRoute,
    walletRoute,
    playgroundRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
