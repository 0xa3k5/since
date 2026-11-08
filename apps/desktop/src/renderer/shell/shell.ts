import { $ } from '../lib/ui.ts';
// Types only, so no module above the shell loads from here.
import type { lanesView } from '../lanes/lanes-view.ts';
import type { catchupView } from '../catchup/catchup-view.ts';
import type { BranchesView } from '../branches/branches-view.ts';
import type { ReviewView } from '../review/review-view.ts';
import type { MapView } from '../graph/map.ts';
import type { CommitView } from '../commit/commit-view.ts';

// Shell: the window's views and layout elements, set at boot and read by every area.

type LanesPage = ReturnType<typeof lanesView>;
type CatchupPage = ReturnType<typeof catchupView>;
const root = $('#app') as HTMLElement; // index.html always has #app
let sidebarEl: HTMLElement | null | undefined, topbarEl: HTMLElement | null | undefined, bannerEl: HTMLElement | null | undefined, contentEl: HTMLElement | null | undefined;
let mapView: MapView | null = null, commitView: CommitView | null = null, lanesPage: LanesPage | null = null, reviewPage: ReviewView | null = null, catchupPage: CatchupPage | null = null, branchesPage: BranchesView | null = null;
type Run = (() => Promise<unknown>) | null;
let finishedCount = 0, finishedRun: Run = null; // Branches' quiet sidebar badge: "N to clean" (countFinished)
let reviewCount = 0, reviewRun: Run = null; // Review's sidebar badge: the page's Needs you count, stuck plus ready (countReview)
let catchupCount = 0, countRun: Run = null; // Catch up's sidebar badge (setCatchupCount)
let stashFocus: string | null = null; // the stash a sidebar click asked the Stashes page to select
let stashShown: string | null = null; // the stash selected on the Stashes page (for ⌘K)

// Other modules assign these through setters: an imported binding can't be assigned.
function setSidebarEl(value: HTMLElement | null) { return (sidebarEl = value); }
function setTopbarEl(value: HTMLElement | null) { return (topbarEl = value); }
function setBannerEl(value: HTMLElement | null) { return (bannerEl = value); }
function setContentEl(value: HTMLElement | null) { return (contentEl = value); }
function setMapView(value: MapView | null) { return (mapView = value); }
function setCommitView(value: CommitView | null) { return (commitView = value); }
function setCatchupPage(value: CatchupPage | null) { return (catchupPage = value); }
function setBranchesPage(value: BranchesView | null) { return (branchesPage = value); }
function setReviewPage(value: ReviewView | null) { return (reviewPage = value); }
function setStashFocus(value: string | null) { return (stashFocus = value); }
function setStashShown(value: string | null) { return (stashShown = value); }
function setLanesPage(value: LanesPage | null) { return (lanesPage = value); }
function assignCatchupCount(value: number) { return (catchupCount = value); }
function setCountRun(value: Run) { return (countRun = value); }
function assignFinishedCount(value: number) { return (finishedCount = value); }
function setFinishedRun(value: Run) { return (finishedRun = value); }
function assignReviewCount(value: number) { return (reviewCount = value); }
function setReviewRun(value: Run) { return (reviewRun = value); }

export { bannerEl, mapView, lanesPage, branchesPage, catchupPage, reviewPage, commitView, root, sidebarEl, topbarEl, contentEl, setSidebarEl, setTopbarEl, setBannerEl, setContentEl, catchupCount, finishedCount, reviewCount, setMapView, setCommitView, setCatchupPage, setBranchesPage, setReviewPage, stashFocus, setStashFocus, stashShown, setStashShown, setLanesPage, assignCatchupCount, countRun, setCountRun, assignFinishedCount, finishedRun, setFinishedRun, assignReviewCount, reviewRun, setReviewRun };
