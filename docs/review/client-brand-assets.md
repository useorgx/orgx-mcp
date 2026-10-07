# Client identity asset provenance

These monochrome marks identify the explicitly reported originating client.
Each mark is paired with its client name, secondary to OrgX, and decorative to
assistive technology. They do not indicate a partnership, endorsement, model,
execution result, or host certification. Codex and ChatGPT share OpenAI's mark
but retain distinct text labels. Unknown/unreported clients get text only.

| Mark | Source | Original SHA-256 |
| --- | --- | --- |
| Claude | Existing `hopeatina/orgx` asset `orgx/tools/film-kit/assets/logos/claude.svg`, app base `1f2ad0d8da45` | `728cd046c80d287be6bb3f52f753e26147f20e0b39e648baad7d4c618cf935f5` |
| OpenAI | Existing `hopeatina/orgx` asset `orgx/tools/film-kit/assets/logos/openai.svg`, app base `1f2ad0d8da45`; [official brand guidance](https://openai.com/brand/) | `23f62f92a82e75e6a5fd8c9c678cb08db46f09d51c5ca295b8365292543db3a9` |
| Cursor | `CUBE_2D_DARK.svg` in the asset ZIP linked by [Cursor's official brand page](https://cursor.com/brand), retrieved 2026-10-07 | ZIP: `97488a7751914e60f9ff532bc33810cdeaebdddc017548abe6ca2bc29bbc3928` |

The original path geometry is preserved. Black/white fill is expressed as
`currentColor` to stay monochrome across host themes; SVGs are marked
`aria-hidden="true"`. Assets are bundled locally in `src/clientBrandAssets.json`;
no external logo fetch or new dependency is introduced. Other known clients
retain text until an appropriately sourced mark is available.
