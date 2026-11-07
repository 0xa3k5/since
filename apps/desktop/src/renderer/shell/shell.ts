import { $ } from '../lib/ui.ts';

// Shell: the window's views and layout elements, set at boot and read by every area.

/** A view or page whose module is still JavaScript. It gets its real type when that module moves (SNC-696). */
type Later = unknown;
const root = $('#app');
let sidebarEl: HTMLElement | undefined, topbarEl: HTMLElement | undefined, bannerEl: HTMLElement | undefined, contentEl: HTMLElement | undefined;
let mapView: Later = null, commitView: Later = null, lanesPage: Later = null, reviewPage: Later = null, catchupPage: Later = null, branchesPage: Later = null;
let finishedCount = 0, finishedRun: Promise<unknown> | null = null; // Branches' quiet sidebar badge: "N to clean" (countFinished)
let reviewCount = 0, reviewRun: Promise<unknown> | null = null; // Review's sidebar badge: the page's Needs you count, stuck plus ready (countReview)
let catchupCount = 0, countRun: Promise<unknown> | null = null; // Catch up's sidebar badge (setCatchupCount)
let stashFocus: string | null = null; // the stash a sidebar click asked the Stashes page to select
let stashShown: string | null = null; // the stash selected on the Stashes page (for ⌘K)

// Other modules assign these through setters: an imported binding can't be assigned.
function setSidebarEl(value: HTMLElement) { return (sidebarEl = value); }
function setTopbarEl(value: HTMLElement) { return (topbarEl = value); }
function setBannerEl(value: HTMLElement) { return (bannerEl = value); }
function setContentEl(value: HTMLElement) { return (contentEl = value); }
function setMapView(value: Later) { return (mapView = value); }
function setCommitView(value: Later) { return (commitView = value); }
function setCatchupPage(value: Later) { return (catchupPage = value); }
function setBranchesPage(value: Later) { return (branchesPage = value); }
function setReviewPage(value: Later) { return (reviewPage = value); }
function setStashFocus(value: string | null) { return (stashFocus = value); }
function setStashShown(value: string | null) { return (stashShown = value); }
function setLanesPage(value: Later) { return (lanesPage = value); }
function assignCatchupCount(value: number) { return (catchupCount = value); }
function setCountRun(value: Promise<unknown> | null) { return (countRun = value); }
function assignFinishedCount(value: number) { return (finishedCount = value); }
function setFinishedRun(value: Promise<unknown> | null) { return (finishedRun = value); }
function assignReviewCount(value: number) { return (reviewCount = value); }
function setReviewRun(value: Promise<unknown> | null) { return (reviewRun = value); }

export { bannerEl, mapView, lanesPage, branchesPage, catchupPage, reviewPage, commitView, root, sidebarEl, topbarEl, contentEl, setSidebarEl, setTopbarEl, setBannerEl, setContentEl, catchupCount, finishedCount, reviewCount, setMapView, setCommitView, setCatchupPage, setBranchesPage, setReviewPage, stashFocus, setStashFocus, stashShown, setStashShown, setLanesPage, assignCatchupCount, countRun, setCountRun, assignFinishedCount, finishedRun, setFinishedRun, assignReviewCount, reviewRun, setReviewRun };
