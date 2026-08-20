# nssharpe.github.io

A self-updating index of every GitHub Pages site under this account, served at
**https://nssharpe.github.io/**.

## How it works

`index.html` is a single self-contained page. On load it fetches
`https://api.github.com/users/nssharpe/repos` (unauthenticated, public repos only),
filters to repos with `has_pages: true`, and renders one entry per site sorted by
most recently pushed. Enabling Pages on any new public repo makes it appear here
automatically — there is nothing to maintain or rebuild.

The last successful API response is cached in `localStorage` as a fallback for the
rare case the anonymous rate limit (60 requests/hour/IP) is hit.

## Hiding a site

Add the repo name to the `EXCLUDE` set near the top of the `<script>` block in
`index.html`. The page itself (`nssharpe.github.io`) is excluded by default.
