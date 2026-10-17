# Artwork fonts

These fonts are bundled only for the offline artwork generator; the Worker does not serve them. Each is distributed under the adjacent SIL Open Font License.

- Instrument Serif Regular: [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/instrumentserif), `InstrumentSerif-Regular.ttf`; license in `InstrumentSerif-OFL.txt`.
- DM Sans: [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/dmsans), `DMSans[opsz,wght].ttf` stored locally as `DMSans.ttf`; license in `DMSans-OFL.txt`.

The generator loads these local files with system font loading disabled so artwork can be regenerated without downloads or machine-specific font substitutions.
