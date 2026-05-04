# ICE rule packs

Built-in ICE-oriented rule packs live under:

`rules/specs/ice/<pack>/<version>/pack.yml`

Each pack directory may include pack-relative codelists and fixtures. The
CLI can load these packs by reference with:

`geoflow validate file.ags --rules ice:<pack>@<version>`

Currently installed:

- `ice:mini@0.1`
