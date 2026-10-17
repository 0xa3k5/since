'use strict';
// Landing page app shots: regenerates the dark-theme screenshots in apps/web/src/assets/app/ from
// the real app, driven against a made-up product repository ("orbit", remote acme/orbit) with
// made-up people, issue keys and pull requests. Nothing touches the network: a fake `gh` answers
// every GitHub question from demo JSON, and a `git` shim points fetches of the GitHub remote at a
// local bare repository. Not part of the e2e suite (its testMatch is *.spec.js). Run it with:
//
//   pnpm --filter @gitlanes/desktop exec playwright test -c e2e/site-shots.config.js
//
// One app launch; the window is set to 1440×900 and captured at the display's scale (2x on Retina).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');

const OUT = path.join(__dirname, '..', '..', 'web', 'src', 'assets', 'app');
const REMOTE_URL = 'https://github.com/acme/orbit.git';
const H = 3600e3;
const D = 24 * H;
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

const PEOPLE = {
  maya: { name: 'Maya Chen', email: 'maya@acme.dev', login: 'maya-chen' },
  theo: { name: 'Theo Park', email: 'theo@acme.dev', login: 'theo-park' },
  priya: { name: 'Priya Raman', email: 'priya@acme.dev', login: 'priya-raman' },
  jonas: { name: 'Jonas Weber', email: 'jonas@acme.dev', login: 'jonas-weber' },
  agent: { name: 'orbit-agent', email: 'agent@acme.dev', login: 'app/orbit-agent', bot: true },
};

// ---------------------------------------------------------------------------------------------
// Demo source files.

const FILES = {
  'README.md': `# Orbit

Usage-based billing for teams. This monorepo holds the web app, the API and the shared packages.

## Getting started

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

- \`apps/web\`: the dashboard (React, Vite)
- \`apps/api\`: the HTTP API (Fastify)
- \`packages/billing\`: charges, retries, invoices
- \`packages/ui\`: shared components
`,
  'package.json': `{
  "name": "orbit",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "eslint ."
  },
  "devDependencies": {
    "eslint": "^9.12.0",
    "turbo": "^2.1.3",
    "typescript": "^5.6.3"
  }
}
`,
  '.github/workflows/ci.yml': `name: CI
on: [pull_request, push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
`,
  'packages/billing/package.json': `{
  "name": "@orbit/billing",
  "version": "2.3.0",
  "main": "src/index.ts",
  "dependencies": {
    "stripe": "^14.18.0",
    "zod": "^3.23.8"
  }
}
`,
  'packages/billing/src/errors.ts': `export class ChargeError extends Error {
  constructor(message: string, readonly options: { cause?: unknown; code?: string } = {}) {
    super(message);
    this.name = 'ChargeError';
  }

  get declineCode(): string | undefined {
    return this.options.code;
  }
}
`,
  'packages/billing/src/retry.ts': `import { ChargeError } from './errors';
import type { Receipt } from './types';

export const MAX_ATTEMPTS = 3;
export const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function backoff(attempt: number): number {
  return BASE_DELAY_MS * 2 ** attempt;
}

export async function retryCharge(charge: () => Promise<Receipt>): Promise<Receipt> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await charge();
    } catch (err) {
      last = err;
      await sleep(backoff(attempt));
    }
  }
  throw new ChargeError('Card charge failed', { cause: last });
}
`,
  'packages/billing/src/types.ts': `export interface Receipt {
  id: string;
  workspaceId: string;
  amountCents: number;
  currency: 'usd' | 'eur' | 'gbp';
  chargedAt: Date;
}

export interface Invoice {
  id: string;
  number: string;
  workspaceId: string;
  totalCents: number;
  status: 'draft' | 'open' | 'paid' | 'void';
  issuedAt: Date;
}
`,
  'packages/billing/src/index.ts': `export * from './errors';
export * from './retry';
export * from './types';
`,
  'apps/api/src/routes/invoices.ts': `import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listInvoices } from '../db/invoices';

const Query = z.object({
  workspace: z.string().uuid(),
  status: z.enum(['draft', 'open', 'paid', 'void']).optional(),
});

export async function invoiceRoutes(app: FastifyInstance) {
  app.get('/invoices', async (req) => {
    const q = Query.parse(req.query);
    return listInvoices(q.workspace, { status: q.status });
  });
}
`,
  'apps/api/src/db/invoices.ts': `import { sql } from './client';
import type { Invoice } from '@orbit/billing';

export async function listInvoices(workspaceId: string, { status }: { status?: Invoice['status'] } = {}) {
  return sql<Invoice[]>\`
    select * from invoices
    where workspace_id = \${workspaceId}
    \${status ? sql\`and status = \${status}\` : sql\`\`}
    order by issued_at desc
  \`;
}
`,
  'apps/web/src/pages/Billing.tsx': `import { useQuery } from '@tanstack/react-query';
import { Card, PageHeader } from '@orbit/ui';
import { InvoicesTable } from '../components/InvoicesTable';
import { api } from '../lib/api';

export function BillingPage({ workspaceId }: { workspaceId: string }) {
  const invoices = useQuery({ queryKey: ['invoices', workspaceId], queryFn: () => api.invoices(workspaceId) });

  return (
    <>
      <PageHeader title="Billing" description="Plan, usage and invoices" />
      <Card title="Invoices">
        <InvoicesTable invoices={invoices.data ?? []} loading={invoices.isLoading} />
      </Card>
    </>
  );
}
`,
  'apps/web/src/components/InvoicesTable.tsx': `import type { Invoice } from '@orbit/billing';
import { Table, Money, StatusPill } from '@orbit/ui';

export function InvoicesTable({ invoices, loading }: { invoices: Invoice[]; loading: boolean }) {
  return (
    <Table loading={loading} empty="No invoices yet">
      {invoices.map((inv) => (
        <Table.Row key={inv.id}>
          <Table.Cell>{inv.number}</Table.Cell>
          <Table.Cell>{inv.issuedAt.toLocaleDateString()}</Table.Cell>
          <Table.Cell><StatusPill status={inv.status} /></Table.Cell>
          <Table.Cell align="right"><Money cents={inv.totalCents} /></Table.Cell>
        </Table.Row>
      ))}
    </Table>
  );
}
`,
  'apps/web/src/onboarding/Checklist.tsx': `import { Checkbox, Stack } from '@orbit/ui';

const STEPS = [
  { id: 'connect', label: 'Connect your payment provider' },
  { id: 'plan', label: 'Create your first plan' },
  { id: 'meter', label: 'Send a usage event' },
];

export function Checklist({ done }: { done: Set<string> }) {
  return (
    <Stack gap={2}>
      {STEPS.map((s) => <Checkbox key={s.id} checked={done.has(s.id)} label={s.label} readOnly />)}
    </Stack>
  );
}
`,
  'apps/web/src/lib/api.ts': `const BASE = import.meta.env.VITE_API_URL ?? '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { credentials: 'include' });
  if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`);
  return res.json() as Promise<T>;
}

export const api = {
  invoices: (workspaceId: string) => get(\`/invoices?workspace=\${workspaceId}\`),
};
`,
  'packages/ui/src/Button.tsx': `import { forwardRef } from 'react';
import { cx } from './cx';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = 'primary', className, ...rest }, ref) => (
  <button ref={ref} className={cx('btn', \`btn-\${variant}\`, className)} {...rest} />
));
`,
  'packages/ui/package.json': `{
  "name": "@orbit/ui",
  "version": "1.8.0",
  "dependencies": {
    "lucide-react": "^0.441.0"
  }
}
`,
  'docs/runbooks/billing.md': `# Billing runbook

## Failed charges

1. Check the retry log in the admin panel.
2. If the card was declined, the workspace owner gets an email.
3. After the last attempt the workspace moves to past due.
`,
};

// ---------------------------------------------------------------------------------------------

test('landing page app shots (dark)', async ({ sandbox, launch }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });

  // Who commits (the commit view shows it): a made-up developer, not the fixtures' tester.
  fs.writeFileSync(path.join(sandbox.home, 'gitconfig'), fs.readFileSync(path.join(sandbox.home, 'gitconfig'), 'utf8')
    .replace('name = E2E Tester', 'name = Maya Chen').replace('email = e2e@example.com', 'email = maya@acme.dev'));

  const repo = sandbox.init('orbit');
  const g = (args, { at = NOW, who = PEOPLE.maya, cwd = repo, ok = [0] } = {}) => {
    const t = `${Math.floor(at / 1000)} +0000`;
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...sandbox.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t },
      }).trim();
    } catch (err) {
      if (ok.includes(err.status)) return String(err.stdout || '').trim();
      throw err;
    }
  };
  const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
  const write = (files) => {
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(repo, f);
      if (c === null) { fs.rmSync(p, { force: true }); continue; }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof c === 'function' ? c(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '') : c);
    }
  };
  const commit = (subject, files, opts) => { write(files); g(['add', '-A'], opts); g(['commit', '-q', '-m', subject], opts); return g(['rev-parse', 'HEAD']); };
  const sub = (from, to) => (s) => { if (!s.includes(from)) throw new Error(`demo edit: “${from.slice(0, 40)}” not found`); return s.replace(from, to); };

  // --- History before the checkpoint: a few weeks of work, with two real merges for the graph.
  let at = NOW - 26 * D;
  const people = [PEOPLE.maya, PEOPLE.theo, PEOPLE.priya, PEOPLE.jonas];
  commit('chore: set up the monorepo', FILES, { at, who: PEOPLE.maya });
  const early = [
    ['feat(api): health check endpoint', { 'apps/api/src/routes/health.ts': "import type { FastifyInstance } from 'fastify';\n\nexport async function healthRoutes(app: FastifyInstance) {\n  app.get('/health', async () => ({ ok: true }));\n}\n" }],
    ['feat(ui): StatusPill and Money components', { 'packages/ui/src/StatusPill.tsx': "const TONE = { draft: 'neutral', open: 'info', paid: 'success', void: 'muted' } as const;\n\nexport function StatusPill({ status }: { status: keyof typeof TONE }) {\n  return <span className={`pill pill-${TONE[status]}`}>{status}</span>;\n}\n", 'packages/ui/src/Money.tsx': "export function Money({ cents, currency = 'usd' }: { cents: number; currency?: string }) {\n  return <>{new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)}</>;\n}\n" }],
    ['fix(web): format invoice dates in the workspace time zone', { 'apps/web/src/components/InvoicesTable.tsx': sub('inv.issuedAt.toLocaleDateString()', 'formatDate(inv.issuedAt)') }],
    ['docs: describe the release process', { 'docs/release.md': '# Releasing\n\n1. Merge to main.\n2. CI tags the build.\n3. Deploy from the dashboard.\n' }],
  ];
  early.forEach(([s, f], i) => commit(s, f, { at: (at += 1.6 * D), who: people[i % 4] }));
  // A merged feature branch and a release branch, as true merges.
  const fork1 = g(['rev-parse', 'HEAD']);
  g(['checkout', '-q', '-b', 'feature/usage-meter']);
  commit('feat(billing): usage meter events', { 'packages/billing/src/meter.ts': "export interface MeterEvent {\n  workspaceId: string;\n  metric: string;\n  quantity: number;\n  at: Date;\n}\n\nexport function sum(events: MeterEvent[], metric: string): number {\n  return events.filter((e) => e.metric === metric).reduce((n, e) => n + e.quantity, 0);\n}\n" }, { at: (at += 0.5 * D), who: PEOPLE.priya });
  commit('test(billing): meter sums by metric', { 'packages/billing/test/meter.test.ts': "import { sum } from '../src/meter';\n\ntest('sums one metric', () => {\n  expect(sum([{ workspaceId: 'w', metric: 'api_calls', quantity: 3, at: new Date() }], 'api_calls')).toBe(3);\n});\n" }, { at: (at += 0.4 * D), who: PEOPLE.priya });
  g(['checkout', '-q', 'main']);
  commit('chore(ci): run lint before tests', { '.github/workflows/ci.yml': sub('      - run: pnpm test\n', '      - run: pnpm typecheck\n      - run: pnpm test\n') }, { at: (at += 0.3 * D), who: PEOPLE.jonas });
  g(['merge', '-q', '--no-ff', '-m', "Merge branch 'feature/usage-meter'", 'feature/usage-meter'], { at: (at += 0.5 * D), who: PEOPLE.priya });
  g(['branch', '-q', '-D', 'feature/usage-meter']);
  g(['checkout', '-q', '-b', 'release/2.3', fork1]);
  commit('fix(api): reject invoices without a workspace', { 'apps/api/src/routes/invoices.ts': sub('workspace: z.string().uuid(),', 'workspace: z.string().uuid({ message: "workspace is required" }),') }, { at: (at += 0.4 * D), who: PEOPLE.theo });
  g(['checkout', '-q', 'main']);
  commit('feat(web): billing page header', { 'apps/web/src/pages/Billing.tsx': sub('description="Plan, usage and invoices"', 'description="Your plan, this month’s usage and past invoices"') }, { at: (at += 0.5 * D), who: PEOPLE.maya });
  g(['merge', '-q', '--no-ff', '-m', "Merge branch 'release/2.3'", 'release/2.3'], { at: (at += 0.5 * D), who: PEOPLE.theo });
  g(['branch', '-q', '-D', 'release/2.3']);
  for (const [s, f, who] of [
    ['refactor(billing): one place for charge errors', { 'packages/billing/src/errors.ts': (c) => `${c}\nexport const isHardDecline = (err: unknown) => err instanceof ChargeError && ['stolen_card', 'lost_card', 'fraudulent'].includes(err.declineCode ?? '');\n` }, PEOPLE.jonas],
    ['chore(deps): bump zod to 3.23.8', { 'apps/api/package.json': '{\n  "name": "@orbit/api",\n  "dependencies": {\n    "fastify": "^4.28.1",\n    "zod": "^3.23.8"\n  }\n}\n' }, PEOPLE.maya],
  ]) commit(s, f, { at: (at += 1.1 * D), who });

  // --- The checkpoint: caught up here three and a half days ago.
  const checkpoint = g(['rev-parse', 'HEAD']);
  const checkpointAt = NOW - 3.6 * D;

  // --- Merged PRs since the checkpoint, squash-merged the way GitHub does it.
  const merged = [];
  const mainAt = {};
  let n = 0;
  const shipped = [
    [212, 'feat(billing): retry schedule per workspace (ORB-142)', 'agent/orb-142-retry-schedule', PEOPLE.agent, {
      'packages/billing/src/schedule.ts': "import { MAX_ATTEMPTS } from './retry';\n\nexport interface RetrySchedule {\n  attempts: number;\n  spacingHours: number[];\n}\n\nexport const DEFAULT_SCHEDULE: RetrySchedule = { attempts: MAX_ATTEMPTS, spacingHours: [1, 24, 72] };\n\nexport function scheduleFor(settings: Partial<RetrySchedule> | null): RetrySchedule {\n  return { ...DEFAULT_SCHEDULE, ...settings };\n}\n",
      'packages/billing/src/index.ts': (c) => `${c}export * from './schedule';\n` }],
    [213, 'feat(onboarding): welcome checklist (ORB-151)', 'feat/orb-151-welcome-checklist', PEOPLE.priya, {
      'apps/web/src/onboarding/Checklist.tsx': sub("  { id: 'meter', label: 'Send a usage event' },\n", "  { id: 'meter', label: 'Send a usage event' },\n  { id: 'invite', label: 'Invite a teammate' },\n") }],
    [214, 'refactor(ui): extract the Button variants', 'maya/button-variants', PEOPLE.maya, {
      'packages/ui/src/Button.tsx': sub("className={cx('btn', `btn-${variant}`, className)}", 'className={cx(VARIANTS[variant], className)}'),
      'packages/ui/src/variants.ts': "export const VARIANTS = {\n  primary: 'btn btn-primary',\n  ghost: 'btn btn-ghost',\n  danger: 'btn btn-danger',\n} as const;\n" }],
    [215, 'feat(api): invoice export endpoint (ORB-160)', 'agent/orb-160-invoice-export', PEOPLE.agent, {
      'apps/api/src/routes/invoices.ts': sub("    return listInvoices(q.workspace, { status: q.status });\n  });\n", "    return listInvoices(q.workspace, { status: q.status });\n  });\n\n  app.get('/invoices/export.csv', async (req, reply) => {\n    const q = Query.parse(req.query);\n    const rows = await listInvoices(q.workspace, { status: q.status });\n    reply.type('text/csv');\n    return toCsv(rows, ['number', 'issuedAt', 'status', 'totalCents']);\n  });\n"),
      'apps/api/src/lib/csv.ts': "export function toCsv<T>(rows: T[], columns: (keyof T)[]): string {\n  const head = columns.join(',');\n  const body = rows.map((r) => columns.map((c) => JSON.stringify(r[c] ?? '')).join(','));\n  return [head, ...body].join('\\n');\n}\n" }],
    [216, 'fix(onboarding): keep checklist progress after a reload (ORB-151)', 'feat/orb-151-keep-progress', PEOPLE.priya, {
      'apps/web/src/onboarding/progress.ts': "const KEY = 'orbit.onboarding';\n\nexport const loadProgress = (): Set<string> => new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'));\nexport const saveProgress = (done: Set<string>) => localStorage.setItem(KEY, JSON.stringify([...done]));\n" }],
    [217, 'feat(billing): email a receipt after a retried charge (ORB-142)', 'agent/orb-142-retry-receipts', PEOPLE.agent, {
      'packages/billing/src/receipts.ts': "import type { Receipt } from './types';\nimport { sendEmail } from '@orbit/mail';\n\nexport async function emailReceipt(receipt: Receipt, to: string, { retried = false } = {}) {\n  await sendEmail({\n    to,\n    template: retried ? 'receipt-after-retry' : 'receipt',\n    data: { amount: receipt.amountCents / 100, currency: receipt.currency, id: receipt.id },\n  });\n}\n" }],
    [218, 'chore(ui): bump the icon set to 0.452', 'maya/icons-0.452', PEOPLE.maya, {
      'packages/ui/package.json': sub('"lucide-react": "^0.441.0"', '"lucide-react": "^0.452.0"') }],
    [219, 'fix(api): stream large invoice exports (ORB-160)', 'agent/orb-160-stream-export', PEOPLE.agent, {
      'apps/api/src/lib/csv.ts': (c) => `${c}\nexport async function* csvStream<T>(rows: AsyncIterable<T>, columns: (keyof T)[]) {\n  yield columns.join(',') + '\\n';\n  for await (const r of rows) yield columns.map((c) => JSON.stringify(r[c] ?? '')).join(',') + '\\n';\n}\n` }],
    [220, 'style(onboarding): tighten the checklist spacing (ORB-151)', 'priya/orb-151-spacing', PEOPLE.priya, {
      'apps/web/src/onboarding/Checklist.tsx': sub('<Stack gap={2}>', '<Stack gap={1.5}>') }],
    [221, 'test(billing): cover retry exhaustion (ORB-142)', 'theo/orb-142-retry-tests', PEOPLE.theo, {
      'packages/billing/test/retry.test.ts': "import { retryCharge, MAX_ATTEMPTS } from '../src/retry';\nimport { ChargeError } from '../src/errors';\n\ntest('gives up after the last attempt', async () => {\n  const charge = vi.fn().mockRejectedValue(new Error('card_declined'));\n  await expect(retryCharge(charge)).rejects.toBeInstanceOf(ChargeError);\n  expect(charge).toHaveBeenCalledTimes(MAX_ATTEMPTS);\n});\n" }],
    [222, 'docs: update the billing runbook', 'docs/billing-runbook', PEOPLE.jonas, {
      'docs/runbooks/billing.md': sub('3. After the last attempt the workspace moves to past due.\n', '3. Retries follow the workspace schedule (default: after 1 h, 1 day and 3 days).\n4. After the last attempt the workspace moves to past due.\n') }],
    [223, 'chore(ci): cache the pnpm store', 'jonas/ci-cache', PEOPLE.jonas, {
      '.github/workflows/ci.yml': sub('        with:\n          node-version: 20\n', '        with:\n          node-version: 20\n          cache: pnpm\n') }],
    [224, 'feat(web): filter invoices by status (ORB-160)', 'theo/orb-160-invoice-filters', PEOPLE.theo, {
      'apps/web/src/components/InvoiceFilters.tsx': "import { Segmented } from '@orbit/ui';\nimport type { Invoice } from '@orbit/billing';\n\nconst OPTIONS: (Invoice['status'] | 'all')[] = ['all', 'open', 'paid', 'void'];\n\nexport function InvoiceFilters({ value, onChange }: { value: string; onChange: (v: string) => void }) {\n  return <Segmented options={OPTIONS} value={value} onChange={onChange} />;\n}\n" }],
    [225, 'fix(billing): add jitter to the retry backoff (ORB-142)', 'theo/orb-142-backoff-jitter', PEOPLE.theo, {
      'packages/billing/src/retry.ts': (c) => c.replace('export const MAX_ATTEMPTS = 3;', 'export const MAX_ATTEMPTS = 4;')
        .replace('  return BASE_DELAY_MS * 2 ** attempt;', '  const jitter = Math.random() * BASE_DELAY_MS;\n  return BASE_DELAY_MS * 2 ** attempt + jitter;') }],
  ];
  const keep = new Set([213, 216, 219, 222]); // merged branches still here: Clean up offers them
  const span = (NOW - 3 * H) - (checkpointAt + 3 * H);
  shipped.forEach(([num, title, branch, who, files], i) => {
    mainAt[num] = g(['rev-parse', 'HEAD']);
    const t = checkpointAt + 3 * H + (span * i) / (shipped.length - 1);
    g(['checkout', '-q', '-b', branch]);
    commit(title.replace(/ \(ORB-\d+\)$/, ''), files, { at: t - 2 * H, who });
    const head = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    g(['merge', '--squash', '-q', branch], { at: t, who });
    g(['commit', '-q', '-m', `${title} (#${num})`], { at: t, who });
    merged.push({ number: num, title, headRefOid: head, headRefName: branch, mergeCommit: { oid: g(['rev-parse', 'HEAD']) }, mergedAt: iso(t), author: who });
    if (!keep.has(num)) g(['branch', '-q', '-D', branch]);
    n++;
  });
  expect(n).toBe(14);

  // --- Open PRs, each on its own branch.
  const open = [];
  const openPr = (o) => {
    g(['checkout', '-q', '-b', o.branch, o.from]);
    o.commits.forEach(([s, f], i) => commit(s, f, { at: o.at - (o.commits.length - 1 - i) * 1.5 * H, who: o.who }));
    o.head = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    open.push(o);
  };
  const ran = (s) => ({ startedAt: iso(NOW - 9 * H), completedAt: iso(NOW - 9 * H + s * 1000) });
  const ok = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/orbit/actions/runs/9120344101/job/2501', ...ran(40 + name.length * 9) });
  const greenChecks = [ok('lint'), ok('test (api)'), ok('test (web)'), ok('build')];
  // Stuck: conflicts with main in retry.ts (#225 changed the same lines).
  openPr({ number: 228, branch: 'agent/orb-176-hard-declines', who: PEOPLE.agent, from: mainAt[222], at: NOW - 5 * H,
    title: 'feat(billing): skip retries for hard card declines (ORB-176)', merge: 'DIRTY', mergeable: 'CONFLICTING', review: 'REVIEW_REQUIRED', checks: greenChecks,
    commits: [
      ['feat(billing): skip retries for hard card declines', { 'packages/billing/src/retry.ts': (c) => c.replace("import { ChargeError } from './errors';", "import { ChargeError, isHardDecline } from './errors';")
        .replace('export const MAX_ATTEMPTS = 3;', 'export const MAX_ATTEMPTS = 5;')
        .replace('  return BASE_DELAY_MS * 2 ** attempt;', '  return Math.min(BASE_DELAY_MS * 2 ** attempt, 30_000);')
        .replace('      last = err;\n', '      last = err;\n      if (isHardDecline(err)) break;\n') }],
      ['test(billing): hard declines stop after one attempt', { 'packages/billing/test/declines.test.ts': "import { retryCharge } from '../src/retry';\nimport { ChargeError } from '../src/errors';\n\ntest('a stolen card is tried once', async () => {\n  const charge = vi.fn().mockRejectedValue(new ChargeError('declined', { code: 'stolen_card' }));\n  await expect(retryCharge(charge)).rejects.toThrow('Card charge failed');\n  expect(charge).toHaveBeenCalledTimes(1);\n});\n" }],
    ] });
  // Stuck: failing checks.
  openPr({ number: 230, branch: 'theo/orb-171-invoice-pdf', who: PEOPLE.theo, from: mainAt[224], at: NOW - 7 * H,
    title: 'feat(web): preview invoices as PDF (ORB-171)', merge: 'BLOCKED', mergeable: 'MERGEABLE', review: 'REVIEW_REQUIRED',
    checks: [ok('lint'), ok('test (api)'), { __typename: 'CheckRun', name: 'test (web)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/orbit/actions/runs/9120344187/job/2510', ...ran(161) }, ok('build')],
    commits: [['feat(web): invoice PDF preview', { 'apps/web/src/components/InvoicePreview.tsx': "import { Document, Page } from 'react-pdf';\n\nexport function InvoicePreview({ url }: { url: string }) {\n  return (\n    <Document file={url} loading=\"Rendering invoice…\">\n      <Page pageNumber={1} width={640} />\n    </Document>\n  );\n}\n" }]] });
  // Ready to merge.
  openPr({ number: 231, branch: 'theo/orb-163-usage-chart', who: PEOPLE.theo, from: mainAt[225], at: NOW - 20 * H,
    title: 'feat(web): usage chart on the billing page (ORB-163)', merge: 'CLEAN', mergeable: 'MERGEABLE', review: 'APPROVED', checks: greenChecks,
    commits: [
      ['feat(web): usage chart component', {
        'apps/web/src/components/UsageChart.tsx': "import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';\nimport type { UsagePoint } from '../lib/usage';\n\nexport function UsageChart({ points, metric }: { points: UsagePoint[]; metric: string }) {\n  if (!points.length) return <p className=\"muted\">No usage this month yet.</p>;\n  return (\n    <ResponsiveContainer width=\"100%\" height={180}>\n      <AreaChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>\n        <XAxis dataKey=\"day\" tickLine={false} axisLine={false} />\n        <Tooltip formatter={(v: number) => [v.toLocaleString(), metric]} />\n        <Area type=\"monotone\" dataKey=\"quantity\" stroke=\"var(--accent)\" fill=\"var(--accent-soft)\" />\n      </AreaChart>\n    </ResponsiveContainer>\n  );\n}\n",
        'apps/web/src/lib/usage.ts': "export interface UsagePoint {\n  day: string;\n  quantity: number;\n}\n\nexport function byDay(events: { at: string; quantity: number }[]): UsagePoint[] {\n  const days = new Map<string, number>();\n  for (const e of events) {\n    const day = e.at.slice(0, 10);\n    days.set(day, (days.get(day) ?? 0) + e.quantity);\n  }\n  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, quantity]) => ({ day, quantity }));\n}\n" }],
      ['feat(web): show usage on the billing page', {
        'apps/web/src/pages/Billing.tsx': (c) => c.replace("import { InvoicesTable } from '../components/InvoicesTable';", "import { InvoicesTable } from '../components/InvoicesTable';\nimport { UsageChart } from '../components/UsageChart';\nimport { byDay } from '../lib/usage';")
          .replace("  const invoices = useQuery({ queryKey: ['invoices', workspaceId], queryFn: () => api.invoices(workspaceId) });\n", "  const invoices = useQuery({ queryKey: ['invoices', workspaceId], queryFn: () => api.invoices(workspaceId) });\n  const usage = useQuery({ queryKey: ['usage', workspaceId], queryFn: () => api.usage(workspaceId, 'api_calls') });\n")
          .replace('      <Card title="Invoices">', '      <Card title="Usage this month">\n        <UsageChart points={byDay(usage.data ?? [])} metric="API calls" />\n      </Card>\n      <Card title="Invoices">'),
        'apps/web/src/lib/api.ts': sub("  invoices: (workspaceId: string) => get(`/invoices?workspace=${workspaceId}`),\n", "  invoices: (workspaceId: string) => get(`/invoices?workspace=${workspaceId}`),\n  usage: (workspaceId: string, metric: string) => get<{ at: string; quantity: number }[]>(`/usage?workspace=${workspaceId}&metric=${metric}`),\n") }],
      ['test(web): usage groups events by day', { 'apps/web/src/lib/usage.test.ts': "import { byDay } from './usage';\n\ntest('adds up events on the same day', () => {\n  expect(byDay([\n    { at: '2026-10-01T09:00:00Z', quantity: 2 },\n    { at: '2026-10-01T17:30:00Z', quantity: 3 },\n    { at: '2026-10-02T08:00:00Z', quantity: 1 },\n  ])).toEqual([{ day: '2026-10-01', quantity: 5 }, { day: '2026-10-02', quantity: 1 }]);\n});\n" }],
    ] });
  openPr({ number: 233, branch: 'agent/orb-174-paginate-export', who: PEOPLE.agent, from: mainAt[225], at: NOW - 9 * H,
    title: 'fix(api): paginate the invoice export (ORB-174)', merge: 'CLEAN', mergeable: 'MERGEABLE', review: 'APPROVED', checks: greenChecks,
    commits: [['fix(api): paginate the invoice export', { 'apps/api/src/db/invoices.ts': (c) => c.replace('    order by issued_at desc\n', '    order by issued_at desc\n    limit ${limit} offset ${offset}\n').replace("{ status }: { status?: Invoice['status'] } = {}", "{ status, limit = 500, offset = 0 }: { status?: Invoice['status']; limit?: number; offset?: number } = {}") }]] });
  openPr({ number: 234, branch: 'maya/stripe-14.21', who: PEOPLE.maya, from: mainAt[225], at: NOW - 2 * H,
    title: 'chore(deps): bump stripe to 14.21', merge: 'CLEAN', mergeable: 'MERGEABLE', review: 'APPROVED', checks: greenChecks,
    commits: [['chore(deps): bump stripe to 14.21', { 'packages/billing/package.json': sub('"stripe": "^14.18.0"', '"stripe": "^14.21.0"') }]] });
  // In progress.
  openPr({ number: 235, branch: 'priya/orb-158-invite-step', who: PEOPLE.priya, from: mainAt[220], at: NOW - 4 * H, draft: true,
    title: 'feat(onboarding): invite your team step (ORB-158)', merge: 'DRAFT', mergeable: 'MERGEABLE', review: 'REVIEW_REQUIRED', checks: [ok('lint'), { __typename: 'CheckRun', name: 'test (web)', status: 'IN_PROGRESS', conclusion: '' }],
    commits: [['feat(onboarding): invite step', { 'apps/web/src/onboarding/InviteStep.tsx': "import { Button, Input, Stack } from '@orbit/ui';\n\nexport function InviteStep({ onInvite }: { onInvite: (emails: string[]) => void }) {\n  return (\n    <form onSubmit={(e) => { e.preventDefault(); onInvite(new FormData(e.currentTarget).getAll('email') as string[]); }}>\n      <Stack gap={1.5}>\n        <Input name=\"email\" type=\"email\" placeholder=\"teammate@company.com\" />\n        <Button type=\"submit\">Send invites</Button>\n      </Stack>\n    </form>\n  );\n}\n" }]] });
  openPr({ number: 236, branch: 'agent/orb-170-search-worker', who: PEOPLE.agent, from: mainAt[223], at: NOW - 1.5 * H,
    title: 'refactor(search): move the indexer to a worker (ORB-170)', merge: 'BLOCKED', mergeable: 'MERGEABLE', review: 'REVIEW_REQUIRED', checks: greenChecks, requested: true,
    commits: [['refactor(search): run the indexer in a worker', { 'apps/web/src/search/indexer.worker.ts': "import { buildIndex } from './index';\n\nself.onmessage = (e: MessageEvent<{ docs: { id: string; text: string }[] }>) => {\n  const index = buildIndex(e.data.docs);\n  self.postMessage(index.toJSON());\n};\n" }]] });

  // --- Lanes Clean up also lists: two branches whose remote branch was deleted.
  const gone = (branch, from, who, subject, files, t) => {
    g(['checkout', '-q', '-b', branch, from]);
    commit(subject, files, { at: t, who });
    g(['checkout', '-q', 'main']);
    g(['config', `branch.${branch}.remote`, 'origin']);
    g(['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  };
  gone('spike/ledger-v2', checkpoint, PEOPLE.jonas, 'spike: double-entry ledger tables', { 'packages/billing/src/ledger.ts': "export interface Entry {\n  account: string;\n  debitCents: number;\n  creditCents: number;\n}\n" }, NOW - 2.5 * D);
  gone('theo/invoice-pdf-poc', checkpoint, PEOPLE.theo, 'poc: render invoices with pdfkit', { 'apps/api/src/lib/pdf.ts': "import PDFDocument from 'pdfkit';\n\nexport function invoicePdf(number: string) {\n  const doc = new PDFDocument();\n  doc.text(`Invoice ${number}`);\n  return doc;\n}\n" }, NOW - 3 * D);

  // --- The "GitHub" remote: a bare repository holding main, the open PR branches and refs/pull/N/head.
  const bare = sandbox.path('orbit-remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: sandbox.env });
  g(['remote', 'add', 'origin', bare]);
  g(['push', '-q', 'origin', 'main', ...open.map((o) => o.branch)]);
  g(['push', '-q', 'origin', ...open.map((o) => `${o.head}:refs/pull/${o.number}/head`), ...merged.map((m) => `${m.headRefOid}:refs/pull/${m.number}/head`)]);
  g(['fetch', '-q', 'origin']);
  for (const o of open) g(['branch', '-q', '-u', `origin/${o.branch}`, o.branch]);
  g(['branch', '-q', '-u', 'origin/main', 'main']);
  g(['remote', 'set-url', 'origin', REMOTE_URL]);
  for (const b of keep) g(['config', `branch.${merged.find((m) => m.number === b).headRefName}.remote`, 'origin']);
  for (const b of keep) { const m = merged.find((x) => x.number === b); g(['config', `branch.${m.headRefName}.merge`, `refs/heads/${m.headRefName}`]); }

  // --- Fake gh and a git shim (fetch / ls-remote / push of the GitHub remote go to the bare repository).
  const bin = sandbox.path('bin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case " $* " in
  *" fetch "*|*" ls-remote "*|*" push "*|*" pull "*) exec '${realGit}' -c 'url.${bare}.insteadOf=${REMOTE_URL}' "$@" ;;
esac
exec '${realGit}' "$@"
`, { mode: 0o755 });
  const author = (p) => ({ login: p.login, name: p.bot ? '' : p.name, is_bot: Boolean(p.bot) });
  const reviewer = (p, state, t) => ({ author: { login: p.login, name: p.name }, state, submittedAt: iso(t) });
  const stat = (o) => {
    const out = g(['diff', '--numstat', `${g(['merge-base', 'main', o.head])}..${o.head}`]).split('\n').filter(Boolean).map((l) => l.split('\t'));
    return { additions: out.reduce((a, x) => a + Number(x[0]), 0), deletions: out.reduce((a, x) => a + Number(x[1]), 0), changedFiles: out.length };
  };
  const reviewsOf = {
    228: [reviewer(PEOPLE.theo, 'COMMENTED', NOW - 4 * H)],
    230: [reviewer(PEOPLE.maya, 'COMMENTED', NOW - 6 * H)],
    231: [reviewer(PEOPLE.maya, 'APPROVED', NOW - 18 * H), reviewer(PEOPLE.priya, 'APPROVED', NOW - 17 * H)],
    233: [reviewer(PEOPLE.theo, 'APPROVED', NOW - 8 * H)],
    234: [reviewer(PEOPLE.jonas, 'APPROVED', NOW - 1.5 * H)],
  };
  const requestsOf = { 228: [PEOPLE.maya], 230: [PEOPLE.priya], 235: [], 236: [PEOPLE.maya, PEOPLE.jonas] };
  const prs = open.map((o) => ({
    number: o.number, title: o.title, headRefName: o.branch, headRefOid: o.head, headRepositoryOwner: { login: 'acme' }, baseRefName: 'main',
    isDraft: Boolean(o.draft), reviewDecision: o.review, statusCheckRollup: o.checks, author: author(o.who),
    url: `https://github.com/acme/orbit/pull/${o.number}`, updatedAt: iso(o.at + 0.3 * H), mergeable: o.mergeable, mergeStateStatus: o.merge,
    latestReviews: reviewsOf[o.number] || [], reviewRequests: (requestsOf[o.number] || []).map((p) => ({ __typename: 'User', login: p.login, name: p.name })),
    state: 'OPEN', isCrossRepository: false, ...stat(o),
  }));
  const tip = g(['rev-parse', 'main']);
  const data = {
    me: PEOPLE.maya.login,
    open: prs,
    requested: open.filter((o) => o.requested).map((o) => ({ number: o.number })),
    merged: merged.map(({ author: _a, ...m }) => ({ ...m, state: 'MERGED' })),
    runs: ['CI', 'Deploy preview', 'CodeQL'].map((w) => ({ headSha: tip, status: 'completed', conclusion: 'success', workflowName: w })),
    repo: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, deleteBranchOnMerge: true, viewerPermission: 'WRITE', defaultBranchRef: { name: 'main' } },
    log: [
      'test (web)\tRun pnpm test\t2026-10-15T09:12:03.1Z  FAIL  src/components/InvoicePreview.test.tsx > renders the first page',
      "test (web)\tRun pnpm test\t2026-10-15T09:12:03.2Z  Error: Setting up fake worker failed: \"Cannot find module 'pdfjs-dist/build/pdf.worker.mjs'\"",
      'test (web)\tRun pnpm test\t2026-10-15T09:12:03.3Z   ❯ src/components/InvoicePreview.tsx:5:5',
      'test (web)\tRun pnpm test\t2026-10-15T09:12:03.4Z  Test Files  1 failed | 41 passed (42)',
    ].join('\n'),
    // PR evidence (AK-520): a description with a screenshot, check annotations and review threads.
    bodies: { 230: 'Renders the invoice PDF next to the line items.\n\n![Invoice preview](https://github.com/user-attachments/assets/6f1c2d3e-0000-4000-8000-000000000230.png)' },
    annotations: { 2510: [
      { path: 'apps/web/src/components/InvoicePreview.test.tsx', start_line: 12, annotation_level: 'failure', message: 'Setting up fake worker failed: Cannot find module pdfjs-dist/build/pdf.worker.mjs' },
      { path: 'apps/web/src/components/InvoicePreview.tsx', start_line: 5, annotation_level: 'warning', message: 'react-pdf: set pdfjs.GlobalWorkerOptions.workerSrc before the first render' },
    ] },
    threads: { 230: { totalCount: 3, nodes: [{ isResolved: false, isOutdated: false }, { isResolved: false, isOutdated: true }, { isResolved: true, isOutdated: false }] } },
  };
  fs.writeFileSync(path.join(bin, 'gh-data.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
'use strict';
const data = require(require('path').join(__dirname, 'gh-data.json'));
const a = process.argv.slice(2);
const has = (x) => a.includes(x);
const val = (k) => a[a.indexOf(k) + 1];
const out = (v) => { process.stdout.write(typeof v === 'string' ? v + '\\n' : JSON.stringify(v)); process.exit(0); };
if (a[0] === 'auth') { process.stderr.write('github.com\\n  ✓ Logged in to github.com account ' + data.me + '\\n'); process.exit(0); }
if (a[0] === 'api' && a[1] === 'user') out(data.me);
if (a[0] === 'pr' && a[1] === 'list') {
  if (val('--state') === 'merged') out(data.merged);
  if (has('--search')) out(data.requested);
  out(data.open);
}
if (a[0] === 'pr' && a[1] === 'view') {
  const n = Number(a[2]);
  const p = data.open.find((x) => x.number === n) || data.merged.find((x) => x.number === n);
  if (!p) { process.stderr.write('no pull requests found\\n'); process.exit(1); }
  if (String(val('--json')).includes('comments')) out({ ...p, body: data.bodies[n] || '', comments: [], reviews: [] });
  out(p);
}
if (a[0] === 'api' && has('graphql')) {
  const n = Number((a.find((x) => x.startsWith('number=')) || '').slice(7));
  out({ data: { repository: { pullRequest: { reviewThreads: data.threads[n] || { totalCount: 0, nodes: [] } } } } });
}
if (a[0] === 'api' && a.some((x) => /check-runs\\/\\d+\\/annotations/.test(x))) {
  out(data.annotations[/check-runs\\/(\\d+)/.exec(a.find((x) => /check-runs\\//.test(x)))[1]] || []);
}
if (a[0] === 'repo' && a[1] === 'view') out(data.repo);
if (a[0] === 'run' && a[1] === 'list') out(data.runs);
if (a[0] === 'run' && a[1] === 'view') out(data.log);
process.stderr.write('demo gh: not supported: ' + a.join(' ') + '\\n');
process.exit(1);
`, { mode: 0o755 });

  // --- Launch (Review is the start view), 1440×900, dark.
  const app = await launch(repo, { theme: 'dark', env: { GITLANES_START_VIEW: '', PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const { page } = app;
  await app.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
  // The catch-up checkpoint: caught up three and a half days ago, then reload so Review picks it up.
  await page.evaluate((cp) => window.gitlanes.app('catchup-mark', cp), { sha: checkpoint, base: 'origin/main', date: checkpointAt, source: 'mark' });
  // Refresh pull requests first: the sidebar keeps them in its cache, and refreshing after the reload
  // would race Review's catch-up load (which then shows commits instead of merged PRs).
  await app.palette('Refresh pull requests');
  await expect(page.locator('.toast', { hasText: '7 open pull requests' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.sidebar .repo-name')).toHaveText('orbit');
  // Toasts never show in a shot (inline styles are blocked by the CSP; CSSOM isn't).
  const quiet = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

  const LEAKS = ['E2E', 'tmp', '/var/', '/Users', '/private', 'gitlanes-e2e', 'Tester', 'orbit-remote'];
  const shot = async (name) => {
    await app.settle(500);
    await page.waitForTimeout(300);
    await quiet();
    const text = await page.evaluate(() => document.body.innerText);
    for (const bad of LEAKS) expect(text, `${name}: “${bad}” is on screen`).not.toContain(bad);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const main = await page.evaluate(() => (document.querySelector('.overlay') || document.querySelector('.content')).innerText);
    console.log(`\n== ${name}\n${main.replace(/\n{2,}/g, '\n').slice(0, 2500)}`);
  };
  const split = page.locator('.review-split');

  // 1. Review: Stuck and Ready to merge.
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await page.locator('.review-reload').click(); // stage counts need a PR load (#143)
  await expect(page.locator('.review-tab[data-tab="stuck"] .review-tab-n')).toHaveText('2', { timeout: 40_000 });
  await expect(page.locator('.review-tab[data-tab="ready"] .review-tab-n')).toHaveText('3');
  // Evidence shots (AK-520), only with EVIDENCE_SHOTS=<dir>: the stuck PR with failing checks in the
  // pane (facts line, evidence strip open on Checks, chips on the rows), dark then light, and stop.
  if (process.env.EVIDENCE_SHOTS) {
    const dir = process.env.EVIDENCE_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    await page.locator('.lanes-row[data-key="pr:230"]').click({ position: { x: 8, y: 8 } });
    const pane = page.locator('.review-pane');
    await expect(pane.locator('.evidence .ev-tab.on')).toContainText('Checks', { timeout: 30_000 });
    await expect(pane.locator('.reader-facts')).toBeVisible({ timeout: 30_000 });
    await pane.locator('.ev-fold').first().click();
    await expect(pane.locator('.ev-log')).toBeVisible();
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await app.palette('Theme: Light');
      await app.settle(500);
      await page.waitForTimeout(400);
      await quiet();
      await page.screenshot({ path: path.join(dir, `evidence-${theme}.png`) });
      await pane.locator('.ev-tab[data-tab="annotations"]').click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(dir, `evidence-annotations-${theme}.png`) });
      await pane.locator('.ev-tab[data-tab="checks"]').click();
    }
    console.log('\n== rows\n' + (await page.locator('.lanes-list').innerText()).slice(0, 1500));
    console.log('\n== pane head\n' + (await pane.locator('.review-pane-head').innerText()).slice(0, 1500));
    return;
  }

  await expect(page.locator('.review-pane .review-row').first()).toBeVisible();
  await shot('review-dark');

  // 2. Catch up (AK-365): Reload joins the merged PRs on, then the walk-through shows the first PR's diff.
  await app.view('catchup');
  const catchup = page.locator('.page.catchup');
  await catchup.press('Shift+R');
  await expect(catchup.locator('.catchup-number')).toContainText('14 PRs merged', { timeout: 40_000 });
  await shot('catchup-timeline-dark');
  await catchup.press('Shift+Enter');
  await expect(page.locator('.lanes-group[data-stage="landed"]')).toContainText('· 14');
  await expect(page.locator('.review-pane .quick-title')).toContainText('#225');
  await expect(page.locator('.review-pane .diff-scroll')).toContainText('jitter');
  await shot('catchup-dark');
  await split.focus();
  await split.press('Escape');
  await expect(catchup).toBeVisible();
  await app.view('lanes');


  // 3. A ready PR in the pane, two files ticked as reviewed.
  const row231 = page.locator('.lanes-row[data-key="pr:231"]');
  await row231.click({ position: { x: 8, y: 8 } });
  const pane = page.locator('.review-pane');
  await expect(pane.locator('.review-list .review-row')).toHaveCount(5);
  await pane.locator('.review-list .review-row', { hasText: 'usage.ts' }).first().locator('.review-tick').click();
  await pane.locator('.review-list .review-row', { hasText: 'usage.test.ts' }).locator('.review-tick').click();
  await expect(pane.locator('.review-list .review-row.reviewed')).toHaveCount(2);
  await pane.locator('.review-list .review-row', { hasText: 'UsageChart.tsx' }).click();
  await expect(pane.locator('.diff-scroll')).toContainText('ResponsiveContainer');
  await shot('review-pr-dark');

  // 4. Send back the conflicting PR.
  const row228 = page.locator('.lanes-row[data-key="pr:228"]');
  await row228.click({ position: { x: 8, y: 8 } });
  await expect(row228).toHaveClass(/active/);
  // The local conflict forecast names the files once it has run; until then the sheet only has GitHub's word.
  const sheet = page.locator('.dialog.sendback');
  await expect(async () => {
    if (await sheet.count()) { await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0); }
    await split.focus();
    await page.keyboard.press('p');
    await expect(sheet.locator('.sendback-prompt')).toHaveValue(/retry\.ts/, { timeout: 1500 });
  }).toPass({ timeout: 30_000 });
  await shot('send-back-dark');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // 5. Merge plan for the ready PRs.
  await split.focus();
  await page.keyboard.press('Shift+P');
  const plan = page.locator('.mergeplan-sheet');
  await expect(plan.locator('.mergeplan-row')).toHaveCount(3, { timeout: 20_000 });
  await expect(plan).toContainText('Order · 3');
  await shot('merge-plan-dark');
  await page.keyboard.press('Escape');
  await expect(plan).toHaveCount(0);

  // 6. Lanes → Clean up.
  await page.keyboard.press('Meta+Alt+Backspace');
  const cleanup = page.locator('.page.cleanup');
  await expect(cleanup).toBeVisible();
  await expect(cleanup.locator('.lanes-row')).toHaveCount(6);
  await shot('cleanup-dark');
  await page.keyboard.press('Escape');

  // 7. Map.
  await app.view('map');
  await expect(app.row('Merge branch \'release/2.3\'')).toHaveCount(1);
  await expect(app.row('fix(billing): add jitter to the retry backoff (ORB-142) (#225)')).toHaveCount(1);
  await app.row('fix(billing): add jitter to the retry backoff (ORB-142) (#225)').click();
  expect((await app.row('fix(billing): add jitter to the retry backoff (ORB-142) (#225)').boundingBox()).y).toBeLessThan(300);
  await shot('map-dark');

  // 8. Commit: staged and unstaged changes, a diff open.
  write({
    'packages/billing/src/receipts.ts': sub("template: retried ? 'receipt-after-retry' : 'receipt',", "template: retried ? 'receipt-after-retry' : 'receipt',\n    replyTo: 'billing@acme.dev',"),
    'apps/web/src/pages/Billing.tsx': sub('<PageHeader title="Billing" description="Your plan, this month’s usage and past invoices" />', '<PageHeader\n        title="Billing"\n        description="Your plan, this month’s usage and past invoices"\n        actions={<Button variant="ghost" onClick={() => api.portal(workspaceId)}>Manage payment method</Button>}\n      />'),
    'packages/billing/src/proration.ts': "import type { Invoice } from './types';\n\n// Credit for the unused part of the period when a workspace changes plan mid-cycle.\nexport function prorate(amountCents: number, periodStart: Date, periodEnd: Date, changedAt: Date): number {\n  const total = periodEnd.getTime() - periodStart.getTime();\n  const unused = periodEnd.getTime() - changedAt.getTime();\n  return Math.round((amountCents * unused) / total);\n}\n\nexport const isProrated = (inv: Invoice) => inv.number.endsWith('-P');\n",
  });
  g(['add', 'packages/billing/src/proration.ts', 'packages/billing/src/receipts.ts']);
  await app.view('commit');
  await expect(page.locator('.cv-section .file-row')).toHaveCount(3);
  await page.locator('textarea.composer-input[placeholder="Commit message"]').fill('feat(billing): prorate plan changes mid-cycle (ORB-181)\n\nCredit the unused part of the period and reply-to billing on receipts.');
  await page.locator('.cv-section .file-row', { hasText: 'Billing.tsx' }).click();
  await expect(page.locator('.diff-scroll')).toContainText('Manage payment method');
  await shot('commit-dark');

  // 9. The conflict editor: merging the hard-declines branch into main stops on retry.ts.
  await page.locator('textarea.composer-input[placeholder="Commit message"]').fill('');
  g(['reset', '-q', '--hard']);
  g(['clean', '-qfd']);
  g(['merge', 'agent/orb-176-hard-declines'], { ok: [1] });
  await expect(page.locator('.banner')).toContainText('Merge in progress', { timeout: 15_000 });
  await app.view('commit');
  await page.locator('.cv-section', { hasText: 'Conflicts' }).locator('.file-row', { hasText: 'retry.ts' }).click();
  await expect(page.locator('.cf-block').first()).toBeVisible();
  await shot('conflict-dark');
});
