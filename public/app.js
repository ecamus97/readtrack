// Real per-person auth via Supabase (email + password). `currentUser` is now
// the Supabase auth user's uuid (matches profiles.id), and `currentProfile`
// holds the app-specific fields (name, username, avatar_seed). The server
// never trusts a user_id we send it — it always re-derives who's asking from
// the session token attached to every request in api() below.
const supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
let session = null;
let currentUser = null;
let currentProfile = null;
let libraryFilter = 'todos';

const CATEGORY_CHIPS = ['Fiction', 'Fantasy', 'Thriller', 'Mystery', 'Romance', 'History', 'Biography', 'Science', 'Adventure', 'Non-Fiction'];

// Decade chips + a "Custom" option that reveals the from/to number inputs.
// Category and year are independent, combinable filters — either, both, or
// neither can be active at once; whichever are active get sent together to
// /api/browse.
const YEAR_CHIPS = [
  { label: '2020s', from: 2020, to: 2029 },
  { label: '2010s', from: 2010, to: 2019 },
  { label: '2000s', from: 2000, to: 2009 },
  { label: '1990s', from: 1990, to: 1999 },
  { label: 'Before 1990', from: null, to: 1989 },
  { label: 'Custom…', custom: true }
];

// Free, no-API-key avatar generator (DiceBear). Sticking to a single style
// keeps the picker visually consistent — variety comes from the seeds
// (different hair, skin tone, accessories) rather than mixing art styles.
// Value stored is "style:seed" so this could be extended with more styles later.
const AVATAR_OPTIONS = [
  { style: 'adventurer', seed: 'Felix' },
  { style: 'adventurer', seed: 'Aneka' },
  { style: 'adventurer', seed: 'Milo' },
  { style: 'adventurer', seed: 'Luna' },
  { style: 'adventurer', seed: 'Zoe' },
  { style: 'adventurer', seed: 'Max' },
  { style: 'adventurer', seed: 'Coco' },
  { style: 'adventurer', seed: 'Ruby' },
  { style: 'adventurer', seed: 'Leo' },
  { style: 'adventurer', seed: 'Nova' },
  { style: 'adventurer', seed: 'Kai' },
  { style: 'adventurer', seed: 'Mia' },
  { style: 'adventurer', seed: 'Oscar' },
  { style: 'adventurer', seed: 'Ivy' },
  { style: 'adventurer', seed: 'Theo' },
  { style: 'adventurer', seed: 'Sage' },
  { style: 'adventurer', seed: 'Dexter' },
  { style: 'adventurer', seed: 'Willow' },
  { style: 'adventurer', seed: 'Jasper' },
  { style: 'adventurer', seed: 'Hazel' },
  { style: 'adventurer', seed: 'Rio' },
  { style: 'adventurer', seed: 'Wren' },
  { style: 'adventurer', seed: 'Finn' },
  { style: 'adventurer', seed: 'Sunny' }
];
const AVATAR_BG_PALETTE = ['#e4f0ec', '#fbe6df', '#fdf1da', '#e6e0f5', '#dcefef', '#fbe0ea', '#eef0d8', '#e0e8fb'];

function avatarValue(opt) { return `${opt.style}:${opt.seed}`; }

function avatarUrl(value) {
  if (!value) return `https://api.dicebear.com/7.x/adventurer/svg?seed=reader&radius=50`;
  const [style, seed] = value.includes(':') ? value.split(':') : ['adventurer', value];
  return `https://api.dicebear.com/7.x/${style}/svg?seed=${encodeURIComponent(seed)}&radius=50`;
}

function avatarPickerHtml(selected, inputId) {
  const initial = selected || avatarValue(AVATAR_OPTIONS[0]);
  return `
    <input type="hidden" id="${inputId}" value="${escapeHtml(initial)}">
    <div class="avatar-picker" data-input="${inputId}">
      ${AVATAR_OPTIONS.map((o, i) => {
        const value = avatarValue(o);
        return `
        <div class="avatar-option ${value === initial ? 'selected' : ''}" data-value="${value}" style="background:${AVATAR_BG_PALETTE[i % AVATAR_BG_PALETTE.length]}">
          <img src="${avatarUrl(value)}" alt="${o.seed}">
        </div>
      `;
      }).join('')}
    </div>
  `;
}

function wireAvatarPicker(container) {
  container.querySelectorAll('.avatar-picker').forEach(picker => {
    const input = document.getElementById(picker.dataset.input);
    picker.querySelectorAll('.avatar-option').forEach(opt => {
      opt.onclick = () => {
        input.value = opt.dataset.value;
        picker.querySelectorAll('.avatar-option').forEach(o => o.classList.toggle('selected', o === opt));
      };
    });
  });
}

async function api(path, opts) {
  const finalOpts = { ...opts, headers: { ...(opts?.headers || {}) } };
  if (session?.access_token) finalOpts.headers['Authorization'] = `Bearer ${session.access_token}`;
  const r = await fetch(path, finalOpts);
  if (r.status === 401) {
    // Session expired or was revoked — send the person back to the login screen.
    await handleLoggedOut();
    throw new Error('Your session expired — please log in again');
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || 'Network error');
  }
  return r.json();
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  return (name || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------- Modal ----------

const modalOverlay = document.getElementById('modalOverlay');
const modalBox = document.getElementById('modalBox');

function openModal(html, wide) {
  modalBox.innerHTML = html;
  modalBox.classList.toggle('wide', !!wide);
  modalOverlay.classList.remove('hidden');
}
function closeModal() {
  modalOverlay.classList.add('hidden');
  modalBox.classList.remove('wide');
  modalBox.innerHTML = '';
}
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

function starPickerHtml(name, value) {
  let html = `<div class="star-picker" data-input="${name}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<span data-val="${i}" class="${i <= value ? 'filled' : ''}">★</span>`;
  }
  html += `</div><input type="hidden" id="${name}" value="${value || ''}">`;
  return html;
}

function wireStarPicker(container) {
  container.querySelectorAll('.star-picker').forEach(picker => {
    const inputId = picker.dataset.input;
    picker.querySelectorAll('span').forEach(span => {
      span.onclick = () => {
        const val = parseInt(span.dataset.val);
        document.getElementById(inputId).value = val;
        picker.querySelectorAll('span').forEach(s => s.classList.toggle('filled', parseInt(s.dataset.val) <= val));
      };
    });
  });
}

function confirmModal(title, message, onConfirm) {
  openModal(`
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(message)}</p>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="danger" id="confirmActionBtn">Delete</button>
    </div>
  `);
  document.getElementById('confirmActionBtn').onclick = () => { closeModal(); onConfirm(); };
}

// ---------- Auth (login / signup) ----------

let authMode = 'login';

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('auth_name_wrap').classList.toggle('hidden', authMode !== 'signup');
  document.getElementById('auth_username_wrap').classList.toggle('hidden', authMode !== 'signup');
  document.getElementById('authSubtitle').textContent = authMode === 'signup' ? 'Create your ReadTrack account.' : 'Log in to your account.';
  document.getElementById('authSubmitBtn').textContent = authMode === 'signup' ? 'Sign up' : 'Log in';
  document.getElementById('authToggleLead').textContent = authMode === 'signup' ? 'Already have an account?' : "Don't have an account?";
  document.getElementById('authToggleBtn').textContent = authMode === 'signup' ? 'Log in' : 'Sign up';
  document.getElementById('forgotPasswordRow').classList.toggle('hidden', authMode === 'signup');
  document.getElementById('authError').classList.add('hidden');
}

// ---------- Forgot / reset password ----------

function showForgotForm() {
  document.getElementById('authFormView').classList.add('hidden');
  document.getElementById('resetFormView').classList.add('hidden');
  document.getElementById('forgotFormView').classList.remove('hidden');
  document.getElementById('authSubtitle').textContent = 'Reset your password';
  document.getElementById('authError').classList.add('hidden');
  document.getElementById('forgotSuccess').classList.add('hidden');
}

function showLoginForm() {
  document.getElementById('forgotFormView').classList.add('hidden');
  document.getElementById('resetFormView').classList.add('hidden');
  document.getElementById('authFormView').classList.remove('hidden');
  authMode = 'login';
  document.getElementById('authSubtitle').textContent = 'Log in to your account.';
  document.getElementById('authSubmitBtn').textContent = 'Log in';
  document.getElementById('authToggleLead').textContent = "Don't have an account?";
  document.getElementById('authToggleBtn').textContent = 'Sign up';
  document.getElementById('auth_name_wrap').classList.add('hidden');
  document.getElementById('auth_username_wrap').classList.add('hidden');
  document.getElementById('forgotPasswordRow').classList.remove('hidden');
  document.getElementById('authError').classList.add('hidden');
}

async function requestPasswordReset() {
  const email = document.getElementById('forgot_email').value.trim();
  if (!email) return showAuthError('Enter your email');
  document.getElementById('forgotSubmitBtn').disabled = true;
  document.getElementById('forgotSuccess').classList.add('hidden');
  document.getElementById('authError').classList.add('hidden');
  try {
    // Where Supabase's email link sends the person back to, with a one-time
    // recovery token in the URL — window.location.origin so this works both
    // locally and on whatever the deployed URL happens to be.
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) { showAuthError(error.message); return; }
    const successEl = document.getElementById('forgotSuccess');
    successEl.textContent = "If that email has an account, we've sent a reset link to it.";
    successEl.classList.remove('hidden');
  } catch (e) {
    showAuthError(e.message || 'Something went wrong');
  } finally {
    document.getElementById('forgotSubmitBtn').disabled = false;
  }
}

function showResetPasswordForm() {
  document.getElementById('authFormView').classList.add('hidden');
  document.getElementById('forgotFormView').classList.add('hidden');
  document.getElementById('resetFormView').classList.remove('hidden');
  document.getElementById('authSubtitle').textContent = 'Set a new password';
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('appScreen').classList.add('hidden');
}

async function submitNewPassword() {
  const pw = document.getElementById('reset_password').value;
  if (!pw || pw.length < 6) return showAuthError('Password must be at least 6 characters');
  document.getElementById('resetSubmitBtn').disabled = true;
  try {
    const { error } = await supabaseClient.auth.updateUser({ password: pw });
    if (error) { showAuthError(error.message); return; }
    // Drop the one-time recovery token from the URL so refreshing the page
    // doesn't try to reuse it.
    window.history.replaceState({}, document.title, window.location.pathname);
    await onAuthenticated(session);
    showToast('Password updated');
  } catch (e) {
    showAuthError(e.message || 'Something went wrong');
  } finally {
    document.getElementById('resetSubmitBtn').disabled = false;
  }
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function submitAuthForm() {
  const email = document.getElementById('auth_email').value.trim();
  const password = document.getElementById('auth_password').value;
  if (!email || !password) return showAuthError('Email and password are required');

  document.getElementById('authSubmitBtn').disabled = true;
  try {
    if (authMode === 'signup') {
      const name = document.getElementById('auth_name').value.trim();
      const username = document.getElementById('auth_username').value.trim();
      if (!name) { showAuthError('Name is required'); return; }
      const { data, error } = await supabaseClient.auth.signUp({
        email, password,
        options: { data: { name, username: username || null } }
      });
      if (error) { showAuthError(error.message); return; }
      if (!data.session) {
        // Some Supabase projects require email confirmation before a session
        // is issued — let the person know instead of appearing to hang.
        showAuthError('Account created! Check your email to confirm it, then log in.');
        authMode = 'signup';
        toggleAuthMode();
        return;
      }
      await onAuthenticated(data.session);
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) { showAuthError(error.message); return; }
      await onAuthenticated(data.session);
    }
  } catch (e) {
    showAuthError(e.message || 'Something went wrong');
  } finally {
    document.getElementById('authSubmitBtn').disabled = false;
  }
}

async function onAuthenticated(newSession) {
  session = newSession;
  currentUser = session.user.id;
  document.getElementById('authError').classList.add('hidden');
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  await loadMyProfile();
  showView('dashboard');
}

async function handleLoggedOut() {
  session = null;
  currentUser = null;
  currentProfile = null;
  document.getElementById('appScreen').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
}

document.getElementById('logoutBtn').onclick = async () => {
  await supabaseClient.auth.signOut();
  await handleLoggedOut();
};

async function loadMyProfile() {
  try {
    currentProfile = await api('/api/profile');
  } catch (e) {
    showToast(`Couldn't load your profile: ${e.message}`);
    return;
  }
  document.getElementById('greetingName').textContent = ', ' + (currentProfile?.name || '');
  document.getElementById('headerUserName').textContent = currentProfile?.name || '';
  document.getElementById('profileAvatar').src = avatarUrl(currentProfile?.avatar_seed || currentProfile?.username || currentProfile?.name);
}

// Clicking the "reset password" link in the email lands back here with a
// one-time token in the URL (#access_token=...&type=recovery). Supabase-js
// picks that up automatically and fires a PASSWORD_RECOVERY event — we catch
// it here so we show the "set a new password" screen instead of dropping the
// person straight into the app.
const isPasswordRecoveryLink = window.location.hash.includes('type=recovery');

supabaseClient.auth.onAuthStateChange((event, newSession) => {
  if (event === 'PASSWORD_RECOVERY') {
    session = newSession;
    showResetPasswordForm();
  }
});

async function initAuth() {
  const { data } = await supabaseClient.auth.getSession();
  if (isPasswordRecoveryLink) {
    // The PASSWORD_RECOVERY listener above handles showing the reset form —
    // don't fall through to the normal logged-in view even if a session
    // already exists at this point.
    if (data.session) { session = data.session; showResetPasswordForm(); }
    return;
  }
  if (data.session) {
    await onAuthenticated(data.session);
  } else {
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('appScreen').classList.add('hidden');
  }
}

// ---------- Navigation ----------

const views = ['dashboard', 'library', 'search', 'social', 'profile', 'club-detail'];
function showView(name) {
  for (const v of views) {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  refreshCurrentView(name);
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  window.__clubModeClubId = null; // leaving via the main nav always exits "add for club" mode
  showView(b.dataset.view);
});

function refreshCurrentView(name) {
  const active = name || currentViewName();
  if (active === 'dashboard') loadDashboard();
  if (active === 'library') loadLibrary();
  if (active === 'search') { loadRecommended(); loadPopular(); updateClubModeBanner(); }
  if (active === 'social') loadSocial();
  if (active === 'profile') loadProfile();
  if (active === 'club-detail') loadClubDetail();
}

function currentViewName() {
  const activeNavBtn = document.querySelector('nav button.active');
  if (activeNavBtn) return activeNavBtn.dataset.view;
  return views.find(v => !document.getElementById(`view-${v}`).classList.contains('hidden')) || 'dashboard';
}

// ---------- Search & Add ----------

document.getElementById('searchBtn').onclick = doSearch;
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// Current filter state — category and year range are independent and
// combinable; both get sent together to /api/browse whenever either changes.
let activeCategory = null;
let activeYearFrom = null;
let activeYearTo = null;

document.getElementById('categoryFilters').innerHTML = CATEGORY_CHIPS.map(c => `<button class="chip" data-category="${c}">${c}</button>`).join('');
document.querySelectorAll('#categoryFilters .chip').forEach(chip => {
  chip.onclick = () => {
    const alreadyActive = chip.classList.contains('active');
    document.querySelectorAll('#categoryFilters .chip').forEach(c => c.classList.remove('active'));
    activeCategory = alreadyActive ? null : chip.dataset.category;
    if (activeCategory) chip.classList.add('active');
    document.getElementById('searchInput').value = '';
    runFilteredBrowse();
    loadPopular(); // "Popular now" also respects the category filter
  };
});

document.getElementById('yearFilters').innerHTML = YEAR_CHIPS.map((y, i) => `<button class="chip" data-year-index="${i}">${y.label}</button>`).join('');
document.querySelectorAll('#yearFilters .chip').forEach((chip, i) => {
  chip.onclick = () => {
    const def = YEAR_CHIPS[i];
    const alreadyActive = chip.classList.contains('active');
    document.querySelectorAll('#yearFilters .chip').forEach(c => c.classList.remove('active'));
    document.getElementById('yearRangeInputs').classList.add('hidden');

    if (alreadyActive) {
      activeYearFrom = null;
      activeYearTo = null;
      runFilteredBrowse();
      return;
    }
    chip.classList.add('active');
    if (def.custom) {
      document.getElementById('yearRangeInputs').classList.remove('hidden');
      return; // wait for the Apply button — nothing to browse yet
    }
    activeYearFrom = def.from;
    activeYearTo = def.to;
    document.getElementById('searchInput').value = '';
    runFilteredBrowse();
  };
});

document.getElementById('yearRangeApplyBtn').onclick = () => {
  const from = parseInt(document.getElementById('yearFromInput').value) || null;
  const to = parseInt(document.getElementById('yearToInput').value) || null;
  if (!from && !to) return;
  activeYearFrom = from;
  activeYearTo = to;
  document.getElementById('searchInput').value = '';
  runFilteredBrowse();
};

function runFilteredBrowse() {
  if (!activeCategory && !activeYearFrom && !activeYearTo) {
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('resultsHeader').classList.add('hidden');
    return;
  }
  browseCategory(activeCategory, activeYearFrom, activeYearTo);
}

document.getElementById('resultsRefreshBtn').onclick = () => runFilteredBrowse();
document.getElementById('recommendedRefreshBtn').onclick = () => loadRecommended();
document.getElementById('popularRefreshBtn').onclick = () => loadPopular();

function bookCoverHtml(cover_url) {
  return cover_url
    ? `<img src="${cover_url}" onerror="this.parentElement.innerHTML='<span class=\\'placeholder\\'>📕</span>'" />`
    : `<span class="placeholder">📕</span>`;
}

// Cover-only card: just the cover art, nothing else. Title/author and all
// other detail (year, pages, categories) live behind tapping the cover, in
// showBookPreview() below — keeps the grid a clean shelf of covers.
function renderBookGrid(books, source) {
  return books.map((b, i) => `
    <div class="card book-card-cover-only clickable" onclick="showBookPreview(${i}, '${source}')" title="${escapeHtml(b.title)}">
      <div class="cover-wrap">${bookCoverHtml(b.cover_url)}</div>
    </div>
  `).join('') || '<p class="empty-state">No results. Try another search term.</p>';
}

// Which in-memory cache backs each Search & Add grid — 'search' covers both
// free-text search and category/year browse results (they share one cache).
function cacheForSource(source) {
  if (source === 'rec') return window.__recommendedCache;
  if (source === 'popular') return window.__popularCache;
  return window.__searchCache;
}

function showBookPreview(index, source) {
  const arr = cacheForSource(source);
  const b = arr[index];
  if (!b) return;
  const clubMode = !!window.__clubModeClubId;
  openModal(`
    <div class="detail-header">
      <div class="cover-wrap detail-cover">${bookCoverHtml(b.cover_url)}</div>
      <div>
        <h3>${escapeHtml(b.title)}</h3>
        <p>${escapeHtml(b.authors) || 'Unknown author'}</p>
      </div>
    </div>
    <ul class="detail-list">
      <li><span>Publication year</span><strong>${b.published_year || '—'}</strong></li>
      <li><span>Pages</span><strong>${b.pages || '—'}</strong></li>
      <li><span>Categories</span><strong>${escapeHtml(b.categories) || '—'}</strong></li>
    </ul>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Close</button>
      ${clubMode
        ? `<button class="primary" onclick="closeModal(); addBookToClub(${index})">+ Add to club</button>`
        : `<button class="primary" onclick="closeModal(); openAddModal(${index}, '${source}')">+ Add to my library</button>`}
    </div>
  `);
}

function updateClubModeBanner() {
  const banner = document.getElementById('clubModeBanner');
  if (window.__clubModeClubId) {
    banner.classList.remove('hidden');
    banner.innerHTML = `Picking a book for <strong>${escapeHtml(window.__clubModeClubName || 'your book club')}</strong> — results below will be added to the club's reading list. <button class="link-btn" onclick="cancelClubMode()">Cancel</button>`;
  } else {
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }
}

function cancelClubMode() {
  const clubId = window.__clubModeClubId;
  window.__clubModeClubId = null;
  window.__clubModeClubName = null;
  if (clubId) openClubDetail(clubId); else showView('search');
}

async function addBookToClub(index) {
  const book = window.__searchCache[index];
  const clubId = window.__clubModeClubId;
  if (!clubId) return;
  try {
    await api(`/api/clubs/${clubId}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book, status: 'upcoming' })
    });
    showToast('Added to the club reading list');
    window.__clubModeClubId = null;
    window.__clubModeClubName = null;
    openClubDetail(clubId);
  } catch (e) {
    showToast(e.message);
  }
}

function clearBrowseFilters() {
  document.querySelectorAll('#categoryFilters .chip, #yearFilters .chip').forEach(c => c.classList.remove('active'));
  document.getElementById('yearRangeInputs').classList.add('hidden');
  activeCategory = null;
  activeYearFrom = null;
  activeYearTo = null;
}

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  clearBrowseFilters();
  document.getElementById('resultsHeader').classList.add('hidden'); // free-text search results aren't "refreshable" — same query, same results
  const container = document.getElementById('searchResults');
  container.innerHTML = '<p class="empty-state">Searching...</p>';
  let results;
  try {
    results = await api(`/api/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">${escapeHtml(e.message)}</p>`;
    return;
  }
  window.__searchCache = results;
  container.innerHTML = renderBookGrid(results, 'search');
}

// category and yearFrom/yearTo are independent and combinable — any subset
// of them can be present at once (runFilteredBrowse only calls this once at
// least one is set).
async function browseCategory(category, yearFrom, yearTo) {
  document.getElementById('resultsHeader').classList.remove('hidden');
  const container = document.getElementById('searchResults');
  container.innerHTML = '<p class="empty-state">Loading...</p>';
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (yearFrom) params.set('yearFrom', yearFrom);
  if (yearTo) params.set('yearTo', yearTo);
  let results;
  try {
    results = await api(`/api/browse?${params.toString()}`);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">${escapeHtml(e.message)}</p>`;
    return;
  }
  window.__searchCache = results;
  container.innerHTML = renderBookGrid(results, 'search');
}

async function loadRecommended() {
  const section = document.getElementById('recommendedSection');
  const container = document.getElementById('recommended');
  if (window.__clubModeClubId) { section.classList.add('hidden'); return; } // keep the search tab focused on the club pick
  try {
    const data = await api(`/api/recommendations`);
    if (!data.subject || !data.books.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    document.getElementById('recommendedLabel').textContent = `Recommended for you — based on ${data.subject}`;
    window.__recommendedCache = data.books;
    container.innerHTML = renderBookGrid(data.books, 'rec');
  } catch (e) {
    section.classList.add('hidden');
  }
}

// Uses Google Books' ratingsCount/averageRating (OpenLibrary doesn't track
// either), restricted to roughly the last 6 years — "popular" here means
// "popular among recent releases", not just popular ever. Re-runs whenever
// a category filter is toggled so it can reflect that pick too, but doesn't
// depend on one (falls back to a general "fiction" query).
async function loadPopular() {
  const section = document.getElementById('popularSection');
  const container = document.getElementById('popular');
  if (window.__clubModeClubId) { section.classList.add('hidden'); return; }
  try {
    const params = new URLSearchParams();
    if (activeCategory) params.set('category', activeCategory);
    const data = await api(`/api/popular?${params.toString()}`);
    if (!data.books.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    window.__popularCache = data.books;
    container.innerHTML = renderBookGrid(data.books, 'popular');
  } catch (e) {
    section.classList.add('hidden');
  }
}

function ratingFieldHtml(name, value, id) {
  return `
    <div class="modal-field" id="${id}">
      <label>Rating</label>
      ${starPickerHtml(name, value)}
    </div>
  `;
}

function dateFieldsHtml(idPrefix, status, startVal, endVal) {
  const showStart = status === 'leyendo' || status === 'leido';
  const showEnd = status === 'leido';
  return `
    <div class="modal-field ${showStart ? '' : 'hidden'}" id="${idPrefix}_start_wrap">
      <label>Start date</label>
      <input type="date" id="${idPrefix}_start" value="${startVal || ''}">
    </div>
    <div class="modal-field ${showEnd ? '' : 'hidden'}" id="${idPrefix}_end_wrap">
      <label>Finish date</label>
      <input type="date" id="${idPrefix}_end" value="${endVal || ''}">
    </div>
  `;
}

function toggleStatusFields(selectEl, prefix) {
  const status = selectEl.value;
  document.getElementById(`${prefix}_rating_wrap`).classList.toggle('hidden', status !== 'leido');
  document.getElementById(`${prefix}_start_wrap`).classList.toggle('hidden', !(status === 'leyendo' || status === 'leido'));
  document.getElementById(`${prefix}_end_wrap`).classList.toggle('hidden', status !== 'leido');
  // Moving a book to "Reading"/"Read" reveals the start date field — if it
  // doesn't already have one (e.g. it was sitting in "To Read"), default it
  // to today instead of leaving it blank. An empty native date input shows
  // as a greyed-out placeholder until tapped, which looked broken/unset even
  // though the field was working fine.
  const startInput = document.getElementById(`${prefix}_start`);
  if ((status === 'leyendo' || status === 'leido') && startInput && !startInput.value) {
    startInput.value = new Date().toISOString().slice(0, 10);
  }
}

async function openAddModal(index, source) {
  const cache = cacheForSource(source);
  const original = cache[index];
  const missingData = !original.pages || !original.categories;
  // Shows the modal right away with what we already have, while trying to
  // fill in pages/categories in the background (works with or without ISBN —
  // the backend also tries by title/author).
  renderAddModal(index, original, missingData, source);

  if (missingData) {
    try {
      const enriched = await api('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(original)
      });
      cache[index] = enriched;
      // Only re-render if this book's modal is still open.
      if (modalBox.dataset.addIndex === String(index) && modalBox.dataset.addSource === source) {
        renderAddModal(index, enriched, false, source);
      }
    } catch (e) {
      // If enrichment fails, we keep going with the original data; the user
      // can always fill in the fields manually.
    }
  }
}

function renderAddModal(index, book, loadingExtra, source) {
  modalBox.dataset.addIndex = String(index);
  modalBox.dataset.addSource = source;
  const today = new Date().toISOString().slice(0, 10);
  openModal(`
    <h3>Add "${escapeHtml(book.title)}"</h3>
    <div class="modal-field">
      <label>Status</label>
      <select id="m_status" onchange="toggleStatusFields(this, 'm')">
        <option value="por_leer">To Read</option>
        <option value="leyendo">Reading</option>
        <option value="leido">Read</option>
      </select>
    </div>
    <div class="modal-field">
      <label>Pages ${loadingExtra ? '<span class="loading-hint">searching...</span>' : ''}</label>
      <input type="number" id="m_pages" value="${book.pages || ''}" placeholder="e.g. 320">
    </div>
    <div class="modal-field">
      <label>Categories / genres ${loadingExtra ? '<span class="loading-hint">searching...</span>' : ''}</label>
      <input type="text" id="m_categories" value="${escapeHtml(book.categories || '')}" placeholder="e.g. Fiction, Fantasy">
    </div>
    ${dateFieldsHtml('m', 'por_leer', today, today)}
    ${ratingFieldHtml('m_rating', 0, 'm_rating_wrap')}
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="confirmAdd(${index}, '${source}')">Add</button>
    </div>
  `);
  wireStarPicker(modalBox);
  document.getElementById('m_rating_wrap').classList.add('hidden');
  document.getElementById('m_start_wrap').classList.add('hidden');
  document.getElementById('m_end_wrap').classList.add('hidden');
}

async function confirmAdd(index, source) {
  const cache = cacheForSource(source);
  const book = { ...cache[index] };
  book.pages = parseInt(document.getElementById('m_pages').value) || null;
  book.categories = document.getElementById('m_categories').value.trim() || null;
  const status = document.getElementById('m_status').value;
  const rating = parseInt(document.getElementById('m_rating').value) || null;
  const payload = { book, status };
  if (status === 'leido' || status === 'leyendo') payload.start_date = document.getElementById('m_start').value || null;
  if (status === 'leido') {
    payload.rating = rating;
    payload.end_date = document.getElementById('m_end').value || null;
  }
  try {
    await api('/api/user-books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    closeModal();
    showToast('Added to your library');
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- My Library ----------

document.querySelectorAll('#libraryFilters .chip').forEach(chip => {
  chip.onclick = () => {
    document.querySelectorAll('#libraryFilters .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    libraryFilter = chip.dataset.filter;
    loadLibrary();
  };
});

let libraryCache = [];

async function loadLibrary() {
  try {
    libraryCache = await api(`/api/user-books`);
  } catch (e) {
    document.getElementById('library').innerHTML = `<p class="empty-state">Couldn't load your library: ${escapeHtml(e.message)}</p>`;
    return;
  }
  renderLibrary();
  if (!document.getElementById('library-calendar-view').classList.contains('hidden')) renderLibraryCalendar();
}

// Cover-only card. Title, author, status, rating, dates, and the
// "Change status" action all live in the detail view now — tap the cover.
function renderLibrary() {
  const rows = libraryFilter === 'todos' ? libraryCache : libraryCache.filter(b => b.status === libraryFilter);
  const container = document.getElementById('library');
  container.innerHTML = rows.map(b => `
    <div class="card book-card-cover-only clickable" onclick="openBookDetail(${b.id})" title="${escapeHtml(b.title)}">
      <div class="cover-wrap">${bookCoverHtml(b.cover_url)}</div>
    </div>
  `).join('') || '<p class="empty-state">You don\'t have any books in this category yet.</p>';
}

function openBookDetail(id) {
  const b = libraryCache.find(x => x.id === id);
  if (!b) return;
  renderBookDetail(b, false);
}

function renderBookDetail(b, refreshing) {
  const statusLabel = { por_leer: 'To Read', leyendo: 'Reading', leido: 'Read' };
  const missingData = !b.pages || !b.categories;
  openModal(`
    <div class="detail-header">
      <div class="cover-wrap detail-cover">${bookCoverHtml(b.cover_url)}</div>
      <div>
        <h3>${escapeHtml(b.title)}</h3>
        <p>${escapeHtml(b.authors) || 'Unknown author'}</p>
        <span class="status-badge ${b.status}">${statusLabel[b.status]}</span>
      </div>
    </div>
    <ul class="detail-list">
      <li><span>Publication year</span><strong>${b.published_year || '—'}</strong></li>
      <li><span>Pages</span><strong>${refreshing ? '...' : (b.pages || '—')}</strong></li>
      <li><span>Categories</span><strong>${refreshing ? '...' : (escapeHtml(b.categories) || '—')}</strong></li>
      <li><span>Rating</span><strong>${b.rating ? '⭐'.repeat(b.rating) : '—'}</strong></li>
      <li><span>Start date</span><strong>${b.start_date || '—'}</strong></li>
      <li><span>Finish date</span><strong>${b.end_date || '—'}</strong></li>
    </ul>
    ${missingData ? `<button class="secondary" style="width:100%;margin-bottom:10px" ${refreshing ? 'disabled' : ''} onclick="refreshBookData(${b.book_id})">${refreshing ? 'Searching...' : '🔄 Look up missing pages/categories'}</button>` : ''}
    <div class="modal-actions">
      <button class="danger" onclick="closeModal(); confirmDeleteBook(${b.id})">Delete</button>
      <button class="secondary" onclick="closeModal()">Close</button>
      <button class="primary" onclick="closeModal(); openStatusModal(${b.id}, '${b.status}', ${b.rating || 'null'})">Change status</button>
    </div>
  `);
}

function confirmDeleteBook(id) {
  const b = libraryCache.find(x => x.id === id);
  confirmModal('Delete book', `Remove "${b?.title || 'this book'}" from your library? This can't be undone.`, async () => {
    await api(`/api/user-books/${id}`, { method: 'DELETE' });
    showToast('Removed from your library');
    loadLibrary();
  });
}

async function refreshBookData(bookId) {
  const b = libraryCache.find(x => x.book_id === bookId);
  if (!b) return;
  renderBookDetail(b, true);
  try {
    const updated = await api(`/api/books/${bookId}/refresh`, { method: 'POST' });
    b.pages = updated.pages;
    b.categories = updated.categories;
    if (updated.pages || updated.categories) showToast('Data updated');
    else showToast('No additional information found for this book');
  } catch (e) {
    showToast(e.message);
  }
  renderBookDetail(b, false);
}

function openStatusModal(id, currentStatus, currentRating) {
  const b = libraryCache.find(x => x.id === id);
  openModal(`
    <h3>Update status</h3>
    <div class="modal-field">
      <label>Status</label>
      <select id="m_status2" onchange="toggleStatusFields(this, 'm2')">
        <option value="por_leer" ${currentStatus === 'por_leer' ? 'selected' : ''}>To Read</option>
        <option value="leyendo" ${currentStatus === 'leyendo' ? 'selected' : ''}>Reading</option>
        <option value="leido" ${currentStatus === 'leido' ? 'selected' : ''}>Read</option>
      </select>
    </div>
    ${dateFieldsHtml('m2', currentStatus, b?.start_date, b?.end_date)}
    ${ratingFieldHtml('m_rating2', currentRating || 0, 'm2_rating_wrap')}
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="confirmStatusUpdate(${id})">Save</button>
    </div>
  `);
  wireStarPicker(modalBox);
  document.getElementById('m2_rating_wrap').classList.toggle('hidden', currentStatus !== 'leido');
}

async function confirmStatusUpdate(id) {
  const status = document.getElementById('m_status2').value;
  const rating = parseInt(document.getElementById('m_rating2').value) || null;
  const body = { status };
  if (status === 'leido' || status === 'leyendo') body.start_date = document.getElementById('m2_start').value || null;
  if (status === 'leido') {
    body.rating = rating;
    body.end_date = document.getElementById('m2_end').value || null;
  }
  await api(`/api/user-books/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  closeModal();
  showToast('Updated');
  loadLibrary();
}

// ---------- Library Calendar ----------
// Lets the user lay "to read" and "reading" books out on a month calendar:
// to-read books get a planned start (+ optional estimated finish) date the
// user picks; reading books already have a real start_date and can get an
// optional estimated finish date. Each book renders as a colored bar
// spanning the days it covers, Gantt-style, clipped to each week's row.

document.querySelectorAll('#libraryViewTabs .chip').forEach(chip => {
  chip.onclick = () => {
    document.querySelectorAll('#libraryViewTabs .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const view = chip.dataset.libview;
    document.getElementById('library-list-view').classList.toggle('hidden', view !== 'list');
    document.getElementById('library-calendar-view').classList.toggle('hidden', view !== 'calendar');
    if (view === 'calendar') renderLibraryCalendar();
  };
});

let calendarMonth = (() => { const d = new Date(); d.setDate(1); return d; })();

document.getElementById('calPrevBtn').onclick = () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderLibraryCalendar();
};
document.getElementById('calNextBtn').onclick = () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderLibraryCalendar();
};

function schedulableBooks() {
  return libraryCache.filter(b => b.status === 'leyendo' || b.status === 'por_leer');
}

// A book's effective range on the calendar: real start_date for "reading"
// books, planned_start_date for "to read" ones; the end is the estimated
// finish date if set, otherwise it's just a single-day marker.
function bookRange(b) {
  const start = b.status === 'leyendo' ? b.start_date : b.planned_start_date;
  if (!start) return null;
  const end = b.planned_end_date || start;
  return { start, end: end < start ? start : end };
}

function renderLibraryCalendar() {
  const books = schedulableBooks();
  const unscheduled = books.filter(b => !bookRange(b));
  const scheduled = books.filter(b => bookRange(b));

  const unscheduledContainer = document.getElementById('unscheduledBooks');
  unscheduledContainer.innerHTML = unscheduled.length ? `
    <h4 class="section-label" style="margin-top:0">📌 Not scheduled yet</h4>
    <div class="unscheduled-list">
      ${unscheduled.map(b => `
        <div class="unscheduled-item">
          <div class="cover-wrap unscheduled-cover">${bookCoverHtml(b.cover_url)}</div>
          <span>${escapeHtml(b.title)}</span>
          <button class="secondary small" onclick="openScheduleModal(${b.id})">Schedule</button>
        </div>
      `).join('')}
    </div>
  ` : '';

  document.getElementById('calMonthLabel').textContent = calendarMonth.toLocaleDateString('en', { month: 'long', year: 'numeric' });

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(year, month, 1 - startOffset);
  const today = new Date().toISOString().slice(0, 10);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + d);
      days.push(date);
    }
    weeks.push(days);
    if (w >= 4 && days[6].getMonth() !== month) break; // stop once next month starts overflowing past the 5th/6th row
  }

  const palette = { leyendo: 'var(--gold)', por_leer: 'var(--primary)' };

  const gridHtml = `
    <div class="calendar-weekdays">${dayNames.map(n => `<div>${n}</div>`).join('')}</div>
    ${weeks.map(week => {
      const weekStartStr = week[0].toISOString().slice(0, 10);
      const weekEndStr = week[6].toISOString().slice(0, 10);

      // Which books have any overlap with this week, clipped to its bounds.
      const weekBooks = scheduled
        .map(b => {
          const r = bookRange(b);
          if (r.end < weekStartStr || r.start > weekEndStr) return null;
          const startCol = Math.max(0, Math.round((new Date(Math.max(new Date(r.start), week[0])) - week[0]) / 86400000));
          const endCol = Math.min(6, Math.round((new Date(Math.min(new Date(r.end), week[6])) - week[0]) / 86400000));
          return { b, startCol, endCol };
        })
        .filter(Boolean)
        .sort((x, y) => x.startCol - y.startCol);

      // Greedy lane assignment so overlapping bars stack instead of collide.
      const lanes = [];
      for (const item of weekBooks) {
        let lane = lanes.findIndex(lastEndCol => lastEndCol < item.startCol);
        if (lane === -1) { lane = lanes.length; lanes.push(-1); }
        lanes[lane] = item.endCol;
        item.lane = lane;
      }
      const laneCount = lanes.length;

      return `
        <div class="calendar-week" style="--lane-count:${Math.max(laneCount, 1)}">
          ${week.map(date => {
            const inMonth = date.getMonth() === month;
            const dateStr = date.toISOString().slice(0, 10);
            return `<div class="calendar-day ${inMonth ? '' : 'outside'} ${dateStr === today ? 'today' : ''}"><span class="calendar-day-num">${date.getDate()}</span></div>`;
          }).join('')}
          <div class="calendar-bars">
            ${weekBooks.map(item => `
              <div class="calendar-bar" title="${escapeHtml(item.b.title)}"
                   style="grid-column:${item.startCol + 1} / ${item.endCol + 2}; grid-row:${item.lane + 1}; background:${palette[item.b.status]};"
                   onclick="openScheduleModal(${item.b.id})">
                <div class="cover-wrap calendar-bar-cover">${bookCoverHtml(item.b.cover_url)}</div>
                <span>${escapeHtml(item.b.title)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('')}
  `;

  document.getElementById('calendarGrid').innerHTML = gridHtml;
}

function openScheduleModal(userBookId) {
  const b = libraryCache.find(x => x.id === userBookId);
  if (!b) return;
  const isReading = b.status === 'leyendo';
  // A "reading" book normally already has a real start_date, but it's
  // possible to have gotten into that status without one (e.g. changed via
  // the status modal with the date field left empty) — in that case, let the
  // user set it here too, otherwise it can never show up on the calendar.
  const needsStartDate = isReading && !b.start_date;
  openModal(`
    <h3>Schedule "${escapeHtml(b.title)}"</h3>
    ${isReading
      ? (needsStartDate
          ? `<div class="modal-field"><label>Start date</label><input type="date" id="sch_start" value="${new Date().toISOString().slice(0, 10)}"></div>`
          : `<div class="modal-field"><label>Started on</label><input type="date" value="${b.start_date}" disabled></div>`)
      : `<div class="modal-field"><label>Planned start date</label><input type="date" id="sch_start" value="${b.planned_start_date || ''}"></div>`}
    <div class="modal-field">
      <label>Estimated finish date (optional)</label>
      <input type="date" id="sch_end" value="${b.planned_end_date || ''}">
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      ${bookRange(b) ? `<button class="danger" onclick="clearSchedule(${b.id})">Remove from calendar</button>` : ''}
      <button class="primary" onclick="confirmSchedule(${b.id})">Save</button>
    </div>
  `);
}

async function confirmSchedule(userBookId) {
  const b = libraryCache.find(x => x.id === userBookId);
  const isReading = b.status === 'leyendo';
  const needsStartDate = isReading && !b.start_date;
  const body = { planned_end_date: document.getElementById('sch_end').value || null };
  if (!isReading) {
    const start = document.getElementById('sch_start').value;
    if (!start) return showToast('Pick a planned start date');
    body.planned_start_date = start;
  } else if (needsStartDate) {
    const start = document.getElementById('sch_start').value;
    if (!start) return showToast('Pick a start date');
    body.start_date = start;
  }
  try {
    await api(`/api/user-books/${userBookId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    closeModal();
    showToast('Scheduled');
    await loadLibrary();
    renderLibraryCalendar();
  } catch (e) {
    showToast(e.message);
  }
}

async function clearSchedule(userBookId) {
  const b = libraryCache.find(x => x.id === userBookId);
  const body = { planned_end_date: null };
  if (b.status === 'por_leer') body.planned_start_date = null;
  await api(`/api/user-books/${userBookId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  closeModal();
  showToast('Removed from the calendar');
  await loadLibrary();
  renderLibraryCalendar();
}

// ---------- Dashboard ----------

async function loadDashboard() {
  document.getElementById('greetingName').textContent = ', ' + (currentProfile?.name || '');
  const container = document.getElementById('dashboard');
  let stats, readingNow;
  try {
    [stats, readingNow] = await Promise.all([
      api(`/api/stats`),
      api(`/api/reading-now`)
    ]);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Couldn't load your dashboard: ${escapeHtml(e.message)}</p>`;
    return;
  }
  window.__readingNowCache = readingNow;
  const progress = stats.meta_anual ? Math.min(100, Math.round((stats.leidos_este_anio / stats.meta_anual) * 100)) : null;
  const monthProgress = stats.meta_mensual ? Math.min(100, Math.round((stats.leidos_este_mes / stats.meta_mensual) * 100)) : null;

  const genreChipPalette = ['#e4f0ec', '#fbe6df', '#fdf1da', '#e6e0f5', '#dcefef', '#fbe0ea', '#eef0d8', '#e0e8fb'];

  container.innerHTML = `
    <div class="dash-section">
      <h4 class="section-label" style="margin-top:0">Currently reading</h4>
      <div class="reading-now-grid">
        ${readingNow.map(b => `
          <div class="reading-now-card">
            <div class="cover-wrap reading-now-cover clickable" onclick="openReadingNowDetail(${b.id})" title="${escapeHtml(b.title)}">${bookCoverHtml(b.cover_url)}</div>
            <div class="reading-now-body">
              <span class="status-badge ${b.club_name ? 'leyendo' : 'por_leer'}">${b.club_name ? `📚 ${escapeHtml(b.club_name)}` : '👤 Individual'}</span>
              <div class="reading-progress-row">
                <div class="progress-bar reading-progress-bar"><div class="progress-bar-fill" style="width:${b.progress_percent || 0}%"></div></div>
                <span class="reading-progress-pct">${b.progress_percent || 0}%</span>
              </div>
              <button class="secondary small reading-progress-btn" onclick="openProgressModal(${b.id}, ${b.progress_percent || 0})">Update progress</button>
            </div>
          </div>
        `).join('') || '<p class="empty-state">You\'re not reading anything right now. Head to Search & Add to start a book.</p>'}
      </div>
    </div>

    <div class="dash-section goals-row">
      <div class="stat-card highlight">
        <h4>${stats.anio} reading goal</h4>
        <div class="big">${stats.leidos_este_anio}${stats.meta_anual ? ' / ' + stats.meta_anual : ''}</div>
        <div class="caption">${progress != null ? progress + '% of your yearly goal' : "You haven't set a yearly goal yet"}</div>
        ${progress != null ? `<div class="progress-bar"><div class="progress-bar-fill" style="width:${progress}%"></div></div>` : ''}
      </div>
      <div class="stat-card">
        <h4>This month</h4>
        <div class="big">${stats.leidos_este_mes}${stats.meta_mensual ? ' / ' + stats.meta_mensual : ''}</div>
        <div class="caption">${monthProgress != null ? monthProgress + '% of your monthly goal' : "You haven't set a monthly goal yet"}</div>
        ${monthProgress != null ? `<div class="progress-bar"><div class="progress-bar-fill" style="width:${monthProgress}%"></div></div>` : ''}
      </div>
    </div>

    <div class="dash-section dash-two-col">
      <div>
        <h4 class="section-label" style="margin-top:0">At a glance</h4>
        <div class="pill-row">
          <div class="stat-pill"><span class="pill-icon">📚</span><div><div class="pill-number">${stats.total_leidos}</div><div class="pill-label">books read</div></div></div>
          <div class="stat-pill"><span class="pill-icon">📄</span><div><div class="pill-number">${stats.total_paginas.toLocaleString('en')}</div><div class="pill-label">pages read</div></div></div>
          <div class="stat-pill"><span class="pill-icon">⭐</span><div><div class="pill-number">${stats.rating_promedio ?? '—'}</div><div class="pill-label">avg rating</div></div></div>
          <div class="stat-pill"><span class="pill-icon">📖</span><div><div class="pill-number">${stats.total_leyendo}</div><div class="pill-label">reading now</div></div></div>
          <div class="stat-pill"><span class="pill-icon">🗂️</span><div><div class="pill-number">${stats.total_por_leer}</div><div class="pill-label">to read</div></div></div>
          ${stats.dias_promedio_por_libro != null ? `<div class="stat-pill"><span class="pill-icon">⏱️</span><div><div class="pill-number">${stats.dias_promedio_por_libro}</div><div class="pill-label">avg days/book</div></div></div>` : ''}
        </div>
      </div>
      <div>
        <h4 class="section-label" style="margin-top:0">Your reading taste</h4>
        <div class="taste-grid">
          <div>
            <p class="taste-label">Top authors</p>
            <div class="chip-cloud">
              ${stats.top_autores.map(([a, c], i) => `<span class="tag-chip" style="background:${genreChipPalette[i % genreChipPalette.length]}">${escapeHtml(a)} <span class="count">${c}</span></span>`).join('') || '<span class="empty-state">No data yet</span>'}
            </div>
          </div>
          <div>
            <p class="taste-label">Top genres</p>
            <div class="chip-cloud">
              ${stats.top_generos.map(([g, c], i) => `<span class="tag-chip" style="background:${genreChipPalette[i % genreChipPalette.length]}">${escapeHtml(g)} <span class="count">${c}</span></span>`).join('') || '<span class="empty-state">No data yet</span>'}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="dash-section">
      <h4 class="section-label">Reading over time</h4>
      <div class="charts-grid">
        <div class="chart-card">
          <p class="taste-label">Books finished per month</p>
          <div class="chart-canvas-wrap"><canvas id="chartBooksPerMonth"></canvas></div>
        </div>
        <div class="chart-card">
          <p class="taste-label">Pages read per month</p>
          <div class="chart-canvas-wrap"><canvas id="chartPagesPerMonth"></canvas></div>
        </div>
      </div>
    </div>
  `;

  renderDashboardCharts(stats);
}

// Last 12 calendar months ending this month, so the chart always reads left
// (older) to right (most recent) even for months with zero activity.
function lastMonthsLabels(n) {
  const months = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    const label = m.toLocaleDateString('en', { month: 'short', year: '2-digit' });
    months.push({ key, label });
  }
  return months;
}

let __dashCharts = {};
function renderDashboardCharts(stats) {
  if (typeof Chart === 'undefined') return; // Chart.js failed to load (e.g. offline) — dashboard still works without it.

  Object.values(__dashCharts).forEach(c => c && c.destroy());
  __dashCharts = {};

  const months = lastMonthsLabels(12);
  const labels = months.map(m => m.label);
  const booksData = months.map(m => stats.por_mes[m.key] || 0);
  const pagesData = months.map(m => stats.paginas_por_mes[m.key] || 0);

  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2f6f62';
  const primaryLight = getComputedStyle(document.documentElement).getPropertyValue('--primary-light').trim() || '#e4f0ec';
  const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#d9a441';

  const booksCanvas = document.getElementById('chartBooksPerMonth');
  const pagesCanvas = document.getElementById('chartPagesPerMonth');
  if (!booksCanvas || !pagesCanvas) return;

  __dashCharts.books = new Chart(booksCanvas, {
    type: 'bar',
    data: { labels, datasets: [{ data: booksData, backgroundColor: primary, borderRadius: 6, maxBarThickness: 28 }] },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: primaryLight } }, x: { grid: { display: false } } }
    }
  });

  __dashCharts.pages = new Chart(pagesCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: pagesData,
        borderColor: gold,
        backgroundColor: gold + '33',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: gold
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, grid: { color: primaryLight } }, x: { grid: { display: false } } }
    }
  });
}

function openReadingNowDetail(id) {
  const b = (window.__readingNowCache || []).find(x => x.id === id);
  if (!b) return;
  openModal(`
    <div class="detail-header">
      <div class="cover-wrap detail-cover">${bookCoverHtml(b.cover_url)}</div>
      <div>
        <h3>${escapeHtml(b.title)}</h3>
        <p>${escapeHtml(b.authors) || 'Unknown author'}</p>
        <span class="status-badge leyendo">Reading</span>
      </div>
    </div>
    <ul class="detail-list">
      <li><span>Publication year</span><strong>${b.published_year || '—'}</strong></li>
      <li><span>Pages</span><strong>${b.pages || '—'}</strong></li>
      <li><span>Categories</span><strong>${escapeHtml(b.categories) || '—'}</strong></li>
      <li><span>Start date</span><strong>${b.start_date || '—'}</strong></li>
      <li><span>Progress</span><strong>${b.progress_percent || 0}%</strong></li>
    </ul>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Close</button>
      <button class="primary" onclick="closeModal(); openProgressModal(${b.id}, ${b.progress_percent || 0})">Update progress</button>
    </div>
  `);
}

function openProgressModal(userBookId, current) {
  openModal(`
    <h3>Update reading progress</h3>
    <div class="modal-field">
      <label>Progress: <span id="progress_display">${current}</span>%</label>
      <input type="range" id="progress_input" min="0" max="100" step="1" value="${current}"
             oninput="document.getElementById('progress_display').textContent = this.value" style="width:100%">
    </div>
    <p class="settings-hint">Reaching 100% automatically marks this book as read.</p>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="confirmProgressUpdate(${userBookId})">Save</button>
    </div>
  `);
}

async function confirmProgressUpdate(userBookId) {
  const value = parseInt(document.getElementById('progress_input').value);
  try {
    const result = await api(`/api/user-books/${userBookId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress_percent: value })
    });
    closeModal();
    showToast(result.autoCompleted ? 'Nice! Marked as read 🎉' : 'Progress updated');
    loadDashboard();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- Social ----------

document.querySelectorAll('.social-tabs .chip').forEach(chip => {
  chip.onclick = () => {
    document.querySelectorAll('.social-tabs .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const target = chip.dataset.social;
    document.getElementById('social-feed').classList.toggle('hidden', target !== 'feed');
    document.getElementById('social-contacts').classList.toggle('hidden', target !== 'contacts');
    document.getElementById('social-clubs').classList.toggle('hidden', target !== 'clubs');
  };
});

async function loadSocial() {
  // allSettled, not all — one section failing (e.g. clubs) shouldn't blank
  // out the others (e.g. feed) that loaded fine.
  await Promise.allSettled([loadFeed(), loadContacts(), loadIncoming(), loadMyClubs()]);
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  // Postgres timestamps come back from the API as proper ISO 8601 strings
  // (e.g. "2026-07-29T18:35:14.000Z"), which every browser's Date parses
  // natively — no string surgery needed like the old SQLite format required.
  const diffMs = Date.now() - new Date(dateStr);
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(dateStr).toLocaleDateString('en');
}

async function loadFeed() {
  const container = document.getElementById('feed');
  let rows;
  try {
    rows = await api(`/api/feed`);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Couldn't load your feed: ${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!rows.length) {
    container.innerHTML = '<p class="empty-state">No updates yet. Add contacts to see their activity here.</p>';
    return;
  }

  const verb = { leido: 'finished reading', leyendo: 'started reading' };
  const icon = { leido: '✅', leyendo: '📖' };

  // Group consecutive entries under the same relative-time label so the feed
  // reads like a news timeline ("Today", "Yesterday", "3 days ago", ...).
  const groups = [];
  for (const r of rows) {
    const label = timeAgo(r.updated_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  container.innerHTML = groups.map(g => `
    <div class="feed-day-group">
      <h4 class="feed-day-label">${g.label.charAt(0).toUpperCase() + g.label.slice(1)}</h4>
      ${g.rows.map(r => `
        <div class="feed-card feed-card-${r.status}">
          <img class="feed-avatar" src="${avatarUrl(r.avatar_seed || r.username || r.user_name)}" alt="">
          <div class="cover-wrap feed-cover">${bookCoverHtml(r.cover_url)}</div>
          <div class="feed-body">
            <p class="feed-headline">
              <span class="feed-icon">${icon[r.status] || ''}</span>
              <span class="who">${escapeHtml(r.user_name)}</span> ${verb[r.status]} <strong>${escapeHtml(r.title)}</strong>
            </p>
            <p class="feed-meta">${escapeHtml(r.authors) || 'Unknown author'}${r.pages ? ' · ' + r.pages + ' pages' : ''}${r.categories ? ' · ' + escapeHtml(r.categories.split(',')[0].trim()) : ''}</p>
            ${r.status === 'leido' && r.rating ? `<p class="feed-rating">${'⭐'.repeat(r.rating)}</p>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

document.getElementById('addContactBtn').onclick = async () => {
  const username = document.getElementById('usernameInput').value.trim();
  if (!username) return;
  try {
    await api('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_username: username })
    });
    document.getElementById('usernameInput').value = '';
    showToast('Request sent');
    loadContacts();
  } catch (e) {
    showToast(e.message);
  }
};

async function loadContacts() {
  const container = document.getElementById('contactsList');
  let rows;
  try {
    rows = await api(`/api/contacts`);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Couldn't load your contacts: ${escapeHtml(e.message)}</p>`;
    return;
  }
  container.innerHTML = rows.map(c => `
    <div class="contact-row">
      <div class="who">
        <span class="avatar">${initials(c.name)}</span>
        <span>${escapeHtml(c.name)}${c.status === 'pendiente' ? ' <span class="status-badge por_leer">pending</span>' : ''}</span>
      </div>
      <button class="danger" onclick="removeContact('${c.contact_user_id}')">Remove</button>
    </div>
  `).join('') || '<p class="empty-state">No contacts yet. Add one above.</p>';
}

async function loadIncoming() {
  const container = document.getElementById('incomingRequests');
  let rows;
  try {
    rows = await api(`/api/contacts/incoming`);
  } catch (e) {
    container.innerHTML = '';
    return;
  }
  if (!rows.length) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <h3 class="section-label">Requests received</h3>
    ${rows.map(r => `
      <div class="contact-row">
        <div class="who"><span class="avatar">${initials(r.name)}</span><span>${escapeHtml(r.name)}</span></div>
        <button class="primary" onclick="acceptContact(${r.id})">Accept</button>
      </div>
    `).join('')}
  `;
}

async function acceptContact(id) {
  await api(`/api/contacts/${id}/accept`, { method: 'POST' });
  showToast('Contact added');
  loadSocial();
}

async function removeContact(contactUserId) {
  await api('/api/contacts', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_user_id: contactUserId })
  });
  showToast('Contact removed');
  loadContacts();
}

// ---------- Book Clubs ----------

document.getElementById('createClubBtn').onclick = () => {
  openModal(`
    <h3>Create a book club</h3>
    <div class="modal-field">
      <label>Club name</label>
      <input type="text" id="cc_name" placeholder="e.g. Fantasy Fans">
    </div>
    <div class="modal-field">
      <label>Description (optional)</label>
      <input type="text" id="cc_description" placeholder="What's this club about?">
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="confirmCreateClub()">Create</button>
    </div>
  `);
};

async function confirmCreateClub() {
  const name = document.getElementById('cc_name').value.trim();
  const description = document.getElementById('cc_description').value.trim();
  if (!name) return showToast('Club name is required');
  try {
    const club = await api('/api/clubs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: description || null })
    });
    closeModal();
    showToast('Club created');
    openClubDetail(club.id);
  } catch (e) {
    showToast(e.message);
  }
}

async function loadMyClubs() {
  const container = document.getElementById('myClubsList');
  let rows;
  try {
    rows = await api(`/api/clubs`);
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Couldn't load your clubs: ${escapeHtml(e.message)}</p>`;
    return;
  }
  container.innerHTML = rows.map(c => `
    <div class="club-row" onclick="openClubDetail(${c.id})">
      <div class="club-row-icon">📚</div>
      <div class="club-row-body">
        <p class="club-row-name">${escapeHtml(c.name)}${c.role === 'owner' ? ' <span class="status-badge leido">owner</span>' : ''}</p>
        <p class="club-row-meta">${c.member_count} member${c.member_count === 1 ? '' : 's'}${c.description ? ' · ' + escapeHtml(c.description) : ''}</p>
      </div>
    </div>
  `).join('') || '<p class="empty-state">You\'re not in any book clubs yet. Create one or search for one to join.</p>';
}

document.getElementById('clubSearchBtn').onclick = searchClubs;
document.getElementById('clubSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchClubs(); });

async function searchClubs() {
  const q = document.getElementById('clubSearchInput').value.trim();
  const container = document.getElementById('clubSearchResults');
  if (!q) { container.innerHTML = ''; return; }
  container.innerHTML = '<p class="empty-state">Searching...</p>';
  const rows = await api(`/api/clubs/search?q=${encodeURIComponent(q)}`);
  container.innerHTML = rows.map(c => `
    <div class="club-row">
      <div class="club-row-icon">📚</div>
      <div class="club-row-body">
        <p class="club-row-name">${escapeHtml(c.name)}</p>
        <p class="club-row-meta">${c.member_count} member${c.member_count === 1 ? '' : 's'}${c.description ? ' · ' + escapeHtml(c.description) : ''}</p>
      </div>
      ${c.is_member
        ? `<button class="secondary" disabled>Already a member</button>`
        : `<button class="primary" onclick="joinClub(${c.id})">Join</button>`}
    </div>
  `).join('') || '<p class="empty-state">No clubs found with that name.</p>';
}

async function joinClub(clubId) {
  try {
    await api(`/api/clubs/${clubId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    showToast('Joined the club!');
    openClubDetail(clubId);
  } catch (e) {
    showToast(e.message);
  }
}

function openClubDetail(clubId) {
  window.__currentClubId = clubId;
  showView('club-detail');
}

document.getElementById('backToClubsBtn').onclick = () => {
  showView('social');
  document.querySelector('.social-tabs .chip[data-social="clubs"]').click();
};

async function loadClubDetail() {
  const clubId = window.__currentClubId;
  if (!clubId) { showView('social'); return; }
  let club;
  try {
    club = await api(`/api/clubs/${clubId}`);
  } catch (e) {
    showToast(e.message);
    showView('social');
    return;
  }

  window.__clubModeClubName = club.name;
  document.getElementById('clubDetailName').textContent = club.name;
  document.getElementById('clubDetailDescription').textContent = club.description || '';
  const isOwner = club.my_role === 'owner';
  const container = document.getElementById('clubDetailContent');

  const statusLabel = { current: 'Currently reading', upcoming: 'Up next', done: 'Finished' };
  const booksByStatus = { current: [], upcoming: [], done: [] };
  for (const b of club.books) booksByStatus[b.status].push(b);
  const currentClubBook = booksByStatus.current[0] || null;

  container.innerHTML = `
    <div class="club-actions-row">
      ${isOwner ? `<button class="secondary" onclick="openEditClubModal()">Edit club</button>` : ''}
      ${isOwner ? `<button class="danger" onclick="confirmDeleteClub()">Delete club</button>` : `<button class="danger" onclick="confirmLeaveClub()">Leave club</button>`}
    </div>

    <h4 class="section-label" style="margin-top:0">Members (${club.members.length})</h4>
    <div class="club-members-grid">
      ${club.members.map(m => `
        <div class="club-member-card">
          <img src="${avatarUrl(m.avatar_seed || m.username || m.name)}" alt="">
          <p>${escapeHtml(m.name)}${m.role === 'owner' ? ' <span class="status-badge leido">owner</span>' : ''}</p>
          ${isOwner && m.role !== 'owner' ? `<button class="danger small" onclick="removeClubMember('${m.id}')">Remove</button>` : ''}
        </div>
      `).join('')}
    </div>

    <div class="club-section-header">
      <h4 class="section-label">Reading list</h4>
      ${isOwner ? `<button class="secondary" onclick="openAddBookForClub()">+ Add book</button>` : ''}
    </div>
    ${['current', 'upcoming', 'done'].map(status => booksByStatus[status].length ? `
      <p class="taste-label">${statusLabel[status]}</p>
      <div class="club-books-list">
        ${booksByStatus[status].map(b => `
          <div class="club-book-row">
            <div class="cover-wrap club-book-cover">${bookCoverHtml(b.cover_url)}</div>
            <div class="club-book-body">
              <p class="club-book-title">${escapeHtml(b.title)}</p>
              <p class="club-book-meta">${escapeHtml(b.authors) || 'Unknown author'}${b.pages ? ' · ' + b.pages + ' pages' : ''}</p>
            </div>
            ${isOwner ? `
              <div class="club-book-actions">
                ${status !== 'current' ? `<button class="secondary small" onclick="setClubBookStatus(${b.club_book_id}, 'current')">Set current</button>` : ''}
                ${status !== 'done' ? `<button class="secondary small" onclick="setClubBookStatus(${b.club_book_id}, 'done')">Mark finished</button>` : ''}
                <button class="danger small" onclick="removeClubBook(${b.club_book_id})">Remove</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    ` : '').join('') || '<p class="empty-state">No books added yet.</p>'}

    <div class="club-section-header">
      <h4 class="section-label">Weekly goals</h4>
      ${isOwner ? `<button class="secondary" onclick="openAddGoalModal()">+ New weekly goal</button>` : ''}
    </div>
    ${club.goals.length ? club.goals.map(g => {
      const mine = g.members.find(m => m.user_id === currentUser);
      const pct = g.total_members ? Math.round((g.completed_count / g.total_members) * 100) : 0;
      // If the goal isn't explicitly tied to a book (or that book was later
      // removed), fall back to showing whatever the club is reading now.
      const bookLabel = g.book_title || currentClubBook?.title || null;
      return `
      <div class="club-goal-card">
        <div class="club-goal-header">
          <div>
            <p class="club-goal-desc">${escapeHtml(g.description)}${bookLabel ? ` <span class="club-goal-book">— ${escapeHtml(bookLabel)}</span>` : ''}</p>
            <p class="club-goal-week">Week of ${new Date(g.week_start).toLocaleDateString('en')}</p>
          </div>
          ${isOwner ? `<button class="danger small" onclick="removeClubGoal(${g.id})">Remove</button>` : ''}
        </div>
        <div class="progress-bar club-goal-progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <p class="club-goal-count">${g.completed_count} / ${g.total_members} members done</p>
        <div class="club-goal-members">
          ${g.members.map(m => `<span class="club-goal-member ${m.completed ? 'done' : ''}">${m.completed ? '✅' : '⬜'} ${escapeHtml(m.name)}</span>`).join('')}
        </div>
        <button class="${mine && mine.completed ? 'secondary' : 'primary'} small" onclick="toggleGoalComplete(${g.id}, ${mine && mine.completed})">
          ${mine && mine.completed ? 'Mark as not done' : 'Mark as done'}
        </button>
      </div>
    `; }).join('') : '<p class="empty-state">No weekly goals yet.</p>'}
  `;
}

function openEditClubModal() {
  api(`/api/clubs/${window.__currentClubId}`).then(club => {
    openModal(`
      <h3>Edit club</h3>
      <div class="modal-field">
        <label>Club name</label>
        <input type="text" id="ec_name" value="${escapeHtml(club.name)}">
      </div>
      <div class="modal-field">
        <label>Description</label>
        <input type="text" id="ec_description" value="${escapeHtml(club.description || '')}">
      </div>
      <div class="modal-actions">
        <button class="secondary" onclick="closeModal()">Cancel</button>
        <button class="primary" onclick="confirmEditClub()">Save</button>
      </div>
    `);
  });
}

async function confirmEditClub() {
  const name = document.getElementById('ec_name').value.trim();
  const description = document.getElementById('ec_description').value.trim();
  try {
    await api(`/api/clubs/${window.__currentClubId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    closeModal();
    showToast('Club updated');
    loadClubDetail();
  } catch (e) {
    showToast(e.message);
  }
}

function confirmDeleteClub() {
  confirmModal('Delete club', 'This will permanently delete the club for everyone. This cannot be undone.', async () => {
    await api(`/api/clubs/${window.__currentClubId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    showToast('Club deleted');
    showView('social');
    document.querySelector('.social-tabs .chip[data-social="clubs"]').click();
  });
}

function confirmLeaveClub() {
  confirmModal('Leave club', 'You will lose access to this club\'s reading list and goals.', async () => {
    await api(`/api/clubs/${window.__currentClubId}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    showToast('You left the club');
    showView('social');
    document.querySelector('.social-tabs .chip[data-social="clubs"]').click();
  });
}

function removeClubMember(memberUserId) {
  confirmModal('Remove member', 'They will lose access to this club.', async () => {
    await api(`/api/clubs/${window.__currentClubId}/members/${memberUserId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    showToast('Member removed');
    loadClubDetail();
  });
}

function openAddBookForClub() {
  window.__clubModeClubId = window.__currentClubId;
  showView('search');
}

async function setClubBookStatus(clubBookId, status) {
  try {
    await api(`/api/clubs/${window.__currentClubId}/books/${clubBookId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    loadClubDetail();
  } catch (e) {
    showToast(e.message);
  }
}

function removeClubBook(clubBookId) {
  confirmModal('Remove book', 'This will remove the book from the club\'s reading list.', async () => {
    await api(`/api/clubs/${window.__currentClubId}/books/${clubBookId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    loadClubDetail();
  });
}

async function openAddGoalModal() {
  const club = await api(`/api/clubs/${window.__currentClubId}`);
  const today = new Date().toISOString().slice(0, 10);
  const currentBook = club.books.find(b => b.status === 'current');
  openModal(`
    <h3>New weekly goal</h3>
    <div class="modal-field">
      <label>What should members complete?</label>
      <input type="text" id="ag_description" placeholder="e.g. Read chapter 1">
    </div>
    <div class="modal-field">
      <label>Week starting</label>
      <input type="date" id="ag_week" value="${today}">
    </div>
    <div class="modal-field">
      <label>Book</label>
      <select id="ag_book">
        ${club.books.map(b => `<option value="${b.club_book_id}" ${currentBook && b.club_book_id === currentBook.club_book_id ? 'selected' : ''}>${escapeHtml(b.title)}${b.status === 'current' ? ' (currently reading)' : ''}</option>`).join('')}
        <option value="">No specific book</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="confirmAddGoal()">Create</button>
    </div>
  `);
}

async function confirmAddGoal() {
  const description = document.getElementById('ag_description').value.trim();
  const week_start = document.getElementById('ag_week').value;
  const club_book_id = document.getElementById('ag_book').value || null;
  if (!description || !week_start) return showToast('Description and week are required');
  try {
    await api(`/api/clubs/${window.__currentClubId}/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, week_start, club_book_id })
    });
    closeModal();
    showToast('Weekly goal created');
    loadClubDetail();
  } catch (e) {
    showToast(e.message);
  }
}

function removeClubGoal(goalId) {
  confirmModal('Remove weekly goal', 'This will remove the goal for everyone in the club.', async () => {
    await api(`/api/clubs/${window.__currentClubId}/goals/${goalId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    loadClubDetail();
  });
}

async function toggleGoalComplete(goalId, isCurrentlyDone) {
  await api(`/api/clubs/${window.__currentClubId}/goals/${goalId}/complete`, {
    method: isCurrentlyDone ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  loadClubDetail();
}

// ---------- Invites ----------

document.getElementById('inviteBtn').onclick = async () => {
  try {
    const { code } = await api('/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    openModal(`
      <h3>Invite a friend</h3>
      <p>Share this code with them. When they join with it, you'll automatically become contacts.</p>
      <div class="invite-code">${code}</div>
      <div class="modal-actions">
        <button class="primary" onclick="closeModal()">Done</button>
      </div>
    `);
  } catch (e) {
    showToast(e.message);
  }
};

document.getElementById('joinBtn').onclick = () => {
  openModal(`
    <h3>Redeem an invite code</h3>
    <p>Enter the code a friend shared with you. You'll automatically become contacts.</p>
    <div class="modal-field">
      <label>Invite code</label>
      <input type="text" id="j_code" placeholder="e.g. AB12CD" style="text-transform:uppercase">
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="confirmJoin()">Redeem</button>
    </div>
  `);
};

async function confirmJoin() {
  const code = document.getElementById('j_code').value.trim();
  if (!code) return showToast('Code is required');
  try {
    const result = await api('/api/invites/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    closeModal();
    showToast(result.contactName ? `You're now connected with ${result.contactName}!` : 'Contact added!');
    loadSocial();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- Profile (avatar, goals, achievements) ----------

document.getElementById('profileBtn').onclick = () => showView('profile');

async function loadProfile() {
  const container = document.getElementById('profileContent');
  try {
    currentProfile = await api('/api/profile');
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Couldn't load your profile: ${escapeHtml(e.message)}</p>`;
    return;
  }
  const u = currentProfile;
  const year = new Date().getFullYear();
  let goal = null;
  try {
    goal = await api(`/api/goals?year=${year}`);
  } catch (e) { /* no goal set yet */ }
  let categories = [];
  try {
    categories = await api(`/api/achievements`);
  } catch (e) { /* ignore */ }
  const totalBadges = categories.reduce((sum, c) => sum + c.badges.length, 0);
  const totalAchieved = categories.reduce((sum, c) => sum + c.badges.filter(b => b.achieved).length, 0);

  container.innerHTML = `
    <div class="profile-header">
      <img src="${avatarUrl(u?.avatar_seed || u?.username || u?.name)}" alt="">
      <div>
        <h3>${escapeHtml(u?.name || '')}</h3>
        <p>${u?.username ? '@' + escapeHtml(u.username) : 'No username set'}</p>
      </div>
    </div>

    <h4 class="section-label" style="margin-top:0">Change avatar</h4>
    ${avatarPickerHtml(u?.avatar_seed || u?.username || u?.name, 'p_avatar')}

    <h4 class="section-label">Achievements <span class="badge-progress">${totalAchieved} / ${totalBadges}</span></h4>
    ${categories.map(cat => `
      <div class="badge-category">
        <h5 class="badge-category-label">${escapeHtml(cat.label)} <span class="badge-progress">${cat.badges.filter(b => b.achieved).length}/${cat.badges.length}</span></h5>
        <div class="badges-grid">
          ${cat.badges.map(b => `
            <div class="badge-card ${b.achieved ? '' : 'locked'}" title="${escapeHtml(b.description)}">
              <div class="badge-icon">${b.icon}</div>
              <div class="badge-label">${escapeHtml(b.label)}</div>
              <div class="badge-desc">${escapeHtml(b.description)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('') || '<p class="empty-state">No achievements yet.</p>'}

    <h4 class="section-label">Reading goals</h4>
    <div class="modal-field">
      <label>Yearly reading goal (${year})</label>
      <input type="number" id="s_target_books" min="0" value="${goal?.target_books || ''}" placeholder="e.g. 24">
    </div>
    <div class="modal-field">
      <label>Monthly reading goal</label>
      <input type="number" id="s_monthly_target" min="0" value="${goal?.monthly_target || ''}" placeholder="e.g. 2">
    </div>

    <div class="modal-actions">
      <button class="primary" onclick="saveProfile(${year})">Save changes</button>
    </div>
  `;
  wireAvatarPicker(container);
}

async function saveProfile(year) {
  const target_books = parseInt(document.getElementById('s_target_books').value) || 0;
  const monthly_target = parseInt(document.getElementById('s_monthly_target').value) || null;
  const avatar_seed = document.getElementById('p_avatar').value;
  await Promise.all([
    api('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, target_books, monthly_target })
    }),
    api('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar_seed })
    })
  ]);
  currentProfile = { ...currentProfile, avatar_seed };
  document.getElementById('profileAvatar').src = avatarUrl(avatar_seed);
  showToast('Profile saved');
  refreshCurrentView('profile');
}

initAuth();
