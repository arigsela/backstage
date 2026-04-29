# application-template

Backstage Software Template that onboards an existing container image as a
managed Kubernetes application. Provisions Deployment + Service + Ingress and
an optional CloudNativePG Postgres via the `XApplication` Crossplane Composition.

## What it does

1. Renders three Nunjucks-templated YAML files into `base-apps/<name>/` and
   one ArgoCD `Application` at `base-apps/<name>.yaml`.
2. Opens a PR against `arigsela/kubernetes`.
3. Registers a `catalog-info.yaml` Location in the Backstage catalog so the
   new app appears as a Component immediately.

## Inputs

| Field | Required | Default | Notes |
|---|---|---|---|
| name | yes | — | Lowercase, hyphenated; becomes namespace + resource prefix |
| owner | yes | — | Backstage Group or User |
| description | no | — | One-line summary |
| image | yes | — | Full container image ref including tag |
| host | yes | — | Public FQDN; DNS must already resolve to the cluster |
| port | no | 8080 | Container port |
| replicas | no | 2 | 1–10 |
| dbNeeded | no | false | Provision a CNPG `Cluster` |
| dbStorage | no | 1Gi | PVC size for the CNPG cluster |

## Companion docs

- Design: `arigsela/kubernetes:docs/superpowers/specs/2026-04-28-backstage-crossplane-idp-design.md`
- Plan: `arigsela/kubernetes:docs/superpowers/plans/2026-04-28-backstage-crossplane-idp.md`
