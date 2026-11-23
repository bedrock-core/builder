# Asset Maps sources

`releases.json` identifies the reviewed Minecraft versions. Each release's
`sources.json` pins three source families.

1. Mojang's Bedrock samples supply native resource and behavior documents,
   identifier metadata, textures, and the samples license. `native-states.json`
   records the BDS state inventory for that release.
2. Mojang's Java client supplies resources and model layers. The version manifest
   pins the client and extraction libraries by SHA-1 and size, and Asset Maps
   verifies their SHA-256 hashes. `src/sources/AssetExtract.java` extracts registry
   defaults, property domains, and model layers.
3. GeyserMC's mapping-generator release supplies Java-to-Bedrock identifier
   and state translations for the selected version pair.

Canonical state selection follows JSPrismarine's inverse mapping policy.
Selection orders candidates by Java block ID, agreement with the actual Java
default state, and Java report order. The source lock records the policy revision.
Unmatched tuples of a mapped block use its first mapped state. Coverage lists
these fallbacks separately from missing source data.

`native-bindings.json` and `texture-rules.json` record reviewed relationships
that native definitions and texture inference cannot establish. Texture aliases
include associations derived from Geyser PackConverter. `renderer-profiles.json`
selects the required Java layers, transforms, and material roles for the pinned
client. Existing Bedrock definitions and entity geometry take precedence.

Native block descriptions may include `internal_vanilla_data`. The raw archive
reader retains the metadata. Normalized block records and generated supplements
omit it. The 1.26.70.23 samples include version-bound numeric block IDs, engine
material and translucency fields, and archetype relationships such as slab pairs
and stair base blocks. Those relationships are candidates for deriving supported
render data from future source releases.

Minecraft assets remain Mojang content under the Minecraft EULA and usage
guidelines. Image files remain upstream. Distributed notices are
[`MOJANG-LICENSE.txt`](dist/MOJANG-LICENSE.txt),
[`GEYSER-LICENSE.txt`](dist/GEYSER-LICENSE.txt),
[`GEYSER-PACKCONVERTER-LICENSE.txt`](dist/GEYSER-PACKCONVERTER-LICENSE.txt)
and [`JSPrismarine-LICENSE.txt`](dist/JSPrismarine-LICENSE.txt).
