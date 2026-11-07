import { $ } from '../lib/ui.ts';

// Shell: the window's views and layout elements, set at boot and read by every area.

const root = $('#app');
let sidebarEl, topbarEl, bannerEl, contentEl;
let mapView = null, commitView = null, lanesPage = null, reviewPage = null, catchupPage = null, branchesPage = null;
let finishedCount = 0, finishedRun = null; // Branches' quiet sidebar badge: "N to clean" (countFinished)
let reviewCount = 0, reviewRun = null; // Review's sidebar badge: the page's Needs you count, stuck plus ready (countReview)
let catchupCount = 0, countRun = null; // Catch up's sidebar badge (setCatchupCount)
let stashFocus = null; // the stash a sidebar click asked the Stashes page to select
let stashShown = null; // the stash selected on the Stashes page (for ⌘K)

// Other modules assign these through setters: an imported binding can't be assigned.
function setSidebarEl(value) { return (sidebarEl = value); }
function setTopbarEl(value) { return (topbarEl = value); }
function setBannerEl(value) { return (bannerEl = value); }
function setContentEl(value) { return (contentEl = value); }
function setMapView(value) { return (mapView = value); }
function setCommitView(value) { return (commitView = value); }
function setCatchupPage(value) { return (catchupPage = value); }
function setBranchesPage(value) { return (branchesPage = value); }
function setReviewPage(value) { return (reviewPage = value); }
function setStashFocus(value) { return (stashFocus = value); }
function setStashShown(value) { return (stashShown = value); }
function setLanesPage(value) { return (lanesPage = value); }
function assignCatchupCount(value) { return (catchupCount = value); }
function setCountRun(value) { return (countRun = value); }
function assignFinishedCount(value) { return (finishedCount = value); }
function setFinishedRun(value) { return (finishedRun = value); }
function assignReviewCount(value) { return (reviewCount = value); }
function setReviewRun(value) { return (reviewRun = value); }

export { bannerEl, mapView, lanesPage, branchesPage, catchupPage, reviewPage, commitView, root, sidebarEl, topbarEl, contentEl, setSidebarEl, setTopbarEl, setBannerEl, setContentEl, catchupCount, finishedCount, reviewCount, setMapView, setCommitView, setCatchupPage, setBranchesPage, setReviewPage, stashFocus, setStashFocus, stashShown, setStashShown, setLanesPage, assignCatchupCount, countRun, setCountRun, assignFinishedCount, finishedRun, setFinishedRun, assignReviewCount, reviewRun, setReviewRun };
