# Magic Mirror

Magic Mirror is a [GitHub App](https://docs.github.com/en/developers/apps/getting-started-with-apps/about-apps) that
mirrors (cherry picks) merged upstream pull-requests (PR) to configured forked repository's branches. It does this by
creating cherry pick PRs on the forked repository and automatically merging them if the PR CI passes. This also has the
added benefit of documenting each upstream PR that is synced.

If a sync from upstream fails, a GitHub issue is created on the forked repository. In that event, Magic Mirror will
pause syncing the forked repository's branch that failure occurred on until the GitHub issue is closed. Therefore,
closing the GitHub issue signals to Magic Mirror that the failed sync was manually corrected or can be ignored.

## GitHub Installation

Installing Magic Mirror on a particular GitHub repository indicates that it should be synced with upstream. Additional
configuration as described in the [Configuration](#configuration) section is still required.

## GitHub Repository Configuration

### Upstream Repositories

The upstream repository must use the "rebase" merge method on all pull-requests (PRs) or require that all PRs only
contain a single commit. The reason is that Magic Mirror is unable to detect which merge method was used on the upstream
PR.

### Forked Repositories

Forked repositories must have the following configured:

- [Required status checks before merging](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#require-status-checks-before-merging)
  if you'd like for CI to pass before the cherry-pick PR is merged.
- [Rebase merges](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github#rebasing-and-merging-your-commits)
  are enabled.
- Merges must not require an
  [approval](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#require-pull-request-reviews-before-merging).
- It's also recommended to enable
  [automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)
  since Magic Mirror works by creating temporary branches on the forked repository.

### Permissions

The GitHub App requires the following repository permissions:

- [Checks](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps#permission-on-checks) read
  access. This is needed to verify that the CI on a PR has passed.
- [Commit statuses](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps#permission-on-statuses)
  read access. This is needed to verify that the CI on a PR has passed.
- [Contents](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps#permission-on-contents) read
  and write access. This is needed so that repository can be cloned and a branch created with the cherry picked upstream
  commits.
- [Issues](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps#permission-on-issues) read and
  write access. This is needed so that the a GitHub issue can be created if a sync from upstream fails.
- [Metadata](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps#metadata-permissions) read
  access. This is mandatory for all GitHub apps.
- [Pull requests](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps#permission-on-pull-requests)
  read and write access. This is needed so that PRs can be created and closed.

### Events

The GitHub app requires being subscribed to the following events:

- [Check run](https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#check_suite)
- [Issues](https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#issues)
- [Pull request](https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#pull_request)
- [Status](https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status)

## Configuration

The configuration file must be present at `./config.json` or `/etc/magic-mirror/config.json`.

- `appID` - the GitHub App ID that is used during authentication with the GitHub API.
- `dbPath` - an optional path to the SQLite database to use or create. This defaults to
  `/etc/magic-mirror/magic-mirror.db`.
- `logLevel` - an optional log level to set. This defaults to `info`. Other options include `debug` or `error`.
- `privateKeyPath` - an optional path to the GitHub App private key used during authentication with the GitHub API. This
  defaults to `/etc/magic-mirror/auth.key`.
- `syncInterval` - an optional interval in seconds for how often Magic Mirror should check for new merged upstream PRs.
  This defaults to `30`.
- `upstreamMappings` - the object that determines which upstream branches should be synced to which fork branches. It
  also optionally defines which labels to add to created PRs. See the example configuration below for a better
  understanding.
- `webhookSecret` - the optional secret that the GitHub webhook event must provide for it to be processed.

Below is an example configuration that syncs from the `main` and `release-0.7` branches in the
`open-cluster-management-io` GitHub organization to the `release-2.6` and `release-2.5` branches in the `stolostron`
GitHub organization respectively. Note that the repositories that are synced would be determined based on which
`stolostron` repositories by the same name as in `open-cluster-management-io` are selected in the GitHub App
installation.

```json
{
  "appID": 2,
  "dbPath": "/etc/magic-mirror/magic-mirror.db",
  "logLevel": "info",
  "privateKeyPath": "/etc/magic-mirror/auth.key",
  "syncInterval": 30,
  "upstreamMappings": {
    "stolostron": {
      "open-cluster-management-io": {
        "branchMappings": {
          "main": "release-2.6",
          "release-0.7": "release-2.5"
        },
        "prLabels": ["ok-to-test"]
      }
    }
  },
  "webhookSecret": "my-secret"
}
```

## Deployment

### Architecture

<img src="images/architecture.png" alt="architecture diagram" width="400px" />

### Prerequisites

- [Create](https://docs.github.com/en/developers/apps/building-github-apps/creating-a-github-app) a GitHub App in the
  GitHub organization with the forks.
  - Set the webhook URL to the root of where you plan to deploy Magic Mirror.
  - Set the documented [permissions](#permissions) and webhook [events](#events).
  - Set a webhook secret.
- Create a `config.json` file based on the [documentation](#configuration).
- [Download](https://docs.github.com/en/developers/apps/building-github-apps/authenticating-with-github-apps#generating-a-private-key)
  a generated private key of your GitHub App and name it `auth.key`.

### Kubernetes

After completing the [prerequisites](#prerequisites), start by creating a namespace to deploy Magic Mirror in.

```shell
kubectl create namespace magic-mirror
```

Create the Kubernetes secret to contain the `config.json` and `auth.key` files setup during the
[prerequisite](#prerequisites) steps.

```shell
kubectl create -n magic-mirror secret generic magic-mirror-config --from-file=config.json --from-file=auth.key
```

Then fill out a `values.yaml` file to customize the [Helm chart's](helm/) default [values.yaml](helm/values.yaml) file.
Below is an example that utilizes [OpenShift's](https://www.redhat.com/en/technologies/cloud-computing/openshift)
default certificate for TLS termination.

```yaml
ingress:
  # Change this to the actual external DNS name that GitHub will use to send webhook events.
  host: magic-mirror.apps.openshift.example.com
  annotations:
    route.openshift.io/termination: edge

configSecret: magic-mirror-config
```

Once you are happy with your `values.yaml` file, you may install Magic Mirror using the following Helm command from the
root of the Git repository.

```shell
helm install magic-mirror ./helm -f values.yaml --namespace=magic-mirror
```
