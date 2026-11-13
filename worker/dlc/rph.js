// Ravensburger Play Hub (RPH) client. Uses global fetch, so it runs unchanged in
// the Worker and in Node (snapshot CLI).

export const RPH_BASE = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';

// Generic on purpose: no site name, no contact details.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; event-stats/1.0)',
  Accept: 'application/json',
};

export async function rphGet(path) {
  const res = await fetch(RPH_BASE + path, { headers: HEADERS });
  if (!res.ok) throw new Error(`RPH returned ${res.status} for ${path}`);
  return res.json();
}

export const fetchEvent = eventId => rphGet(`/events/${eventId}/`);

// The plain /matches endpoint returns 401; /matches/paginated is public.
// page_size up to 1000 is accepted (checked Nov 2026), ~9.5 KB per match.
export const fetchMatchesPage = (roundId, page, pageSize) =>
  rphGet(`/tournament-rounds/${roundId}/matches/paginated/?page=${page}&page_size=${pageSize}`);

// Standings pages cap at 1000 rows, ~1.5 KB per row.
export const fetchStandingsPage = (roundId, page, pageSize) =>
  rphGet(`/tournament-rounds/${roundId}/standings/paginated/?page=${page}&page_size=${pageSize}`);

// Registrations carry each player's deck id once decklists are public (~1.35 KB
// per row, 250 rows per page at most).
export const fetchRegistrationsPage = (eventId, page, pageSize) =>
  rphGet(`/events/${eventId}/registrations/?page=${page}&page_size=${pageSize}`);

// One decklist, ~27 KB.
export const fetchDeck = deckId => rphGet(`/deckbuilder/decks/${deckId}/`);
