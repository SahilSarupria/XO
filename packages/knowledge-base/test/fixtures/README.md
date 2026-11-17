# Knowledge-base test fixtures

`knowledge-schema-1.sqlite` is a knowledge database written by the **schema-1** code. It was generated at commit `2376702`, the
commit before UW-4 introduced schema 2. It is kept as a binary so the v1 → v2 migration is tested against real schema-1 bytes,
not against a schema-2 database with tables dropped.

It holds two tenants, `acme` and `globex`. Each has three approved change sets, one claim each, and one change set still
proposed:

| tenant | head state                    | pending change set            |
| ------ | ----------------------------- | ----------------------------- |
| acme   | `ks_32c6e16451afc304cdaef107` | `cs_9d29168101a0b0c138af8cae` |
| globex | `ks_d0bdc13844fdd416db7b4826` | `cs_0ec1e21a97075fa002de083b` |

Do not regenerate it with current code: a database written now would be schema 2.
