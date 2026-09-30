# Gradle dependencies cache

An opt-in S3 cache for Gradle's downloaded dependencies (`caches/modules-2`) and wrapper distributions (`wrapper/dists`). It streams archives through system `tar`, `zstd`, and the AWS CLI. It does not cache transforms, compiled scripts, build outputs, configuration cache, or Gradle credentials.

This action supports Linux x64 runners. It uses installed tools when available and installs missing `zstd` and AWS CLI tools. Installing `zstd` requires `sudo` and `apt-get`; installing the AWS CLI requires `curl` and `unzip`.

Existing `setup-gradle` caching remains available. To adopt this action in a project, set `cache-disabled: true` in that project's `setup-gradle` steps and add the restore/save steps below. Avoid running both cache implementations in the same job.

## Inputs and output

| Input | Description |
| --- | --- |
| `mode` | Required: `restore` or `save`. Saving is explicit, not a post-action. |
| `aws-s3-bucket` | Required S3 bucket name, without `s3://`. |
| `aws-region` | Optional region override. Otherwise uses the AWS CLI environment/configuration. |
| `key-prefix` | Project prefix. Defaults to `GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX`; one of these must be provided. |
| `dependency-hash` | Optional custom dependency hash. By default, hashes `**/*.versions.toml`, `**/settings.gradle*`, `**/build.gradle*`, and `**/gradle-wrapper.properties`. |

The `cache-hit` output is `true` only after successfully restoring the exact dependency key. It is `false` for a fallback restore, a miss, a failed restore, and save operations.

The action honors `GRADLE_USER_HOME`, including paths relative to `GITHUB_WORKSPACE`. When unset, it uses `$HOME/.gradle`.

## Project storage and credentials

Configure AWS credentials before invoking the action, for example with `aws-actions/configure-aws-credentials`. Existing credentials exported by the project's environment setup action work as well. Readers need S3 list/get access; the writer also needs put access.

Entries use this format:

```text
s3://<aws-s3-bucket>/<project-prefix>/gradle-deps/v1/<dependency-hash>.tar.zst
```

For example, the existing project prefix `business/` produces `business/gradle-deps/v1/`. An explicit `key-prefix` overrides the environment variable. Trailing slashes are normalized. Use a distinct prefix for each project. The namespace separates these archives from existing `gradle-home-v1` entries.

S3 lifecycle rules handle retention. This action never prunes or deletes S3 entries.

## Reader jobs

After checkout, Java setup, and AWS authentication:

```yaml
- name: Setup Gradle
  uses: jobandtalent/gradle-actions/setup-gradle@main
  with:
    cache-disabled: true

- name: Restore Gradle dependencies
  id: gradle-deps
  uses: jobandtalent/gradle-actions/gradle-deps-cache@main
  with:
    mode: restore
    aws-s3-bucket: ${{ secrets.AWS_S3_BUCKET_PRD }}
  env:
    GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX: ${{ vars.GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX }}

- name: Run tests
  run: ./gradlew test
```

Readers try the exact dependency hash first, then the newest archive in the project's namespace. Gradle downloads any missing dependencies after a fallback or cache miss. S3 transfer/list failures warn and allow the build to continue. Restore extraction is staged so failed downloads leave the existing Gradle home intact.

## One writer per project

Use one workflow on the default branch to populate dependencies. Serialize its runs using a workflow `concurrency` group so writers do not overlap. Configure checkout, Java, and AWS credentials before these steps:

```yaml
- name: Setup Gradle
  uses: jobandtalent/gradle-actions/setup-gradle@main
  with:
    cache-disabled: true

- name: Start with an empty dependencies cache
  shell: bash
  run: |
    rm -rf -- "$GRADLE_USER_HOME/caches/modules-2" "$GRADLE_USER_HOME/wrapper/dists"

- name: Download all project dependencies
  run: ./gradlew cacheDeps

- name: Stop Gradle daemons
  run: ./gradlew --stop

- name: Save Gradle dependencies
  uses: jobandtalent/gradle-actions/gradle-deps-cache@main
  with:
    mode: save
    aws-s3-bucket: ${{ secrets.AWS_S3_BUCKET_PRD }}
  env:
    GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX: ${{ vars.GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX }}
```

`cacheDeps` is a project-provided task; the shared action does not create it. Populate all dependencies that reader jobs need. The writer deliberately does not restore an old cache, preventing accumulation across dependency changes. Existing keys are not overwritten, and lock files and `gc.properties` are excluded from the archive. Missing cache directories or upload failures warn and skip saving.

## Custom dependency hashing

For projects that define versions in other files, pass a custom hash in **both readers and the writer**:

```yaml
with:
  mode: restore
  aws-s3-bucket: ${{ secrets.AWS_S3_BUCKET_PRD }}
  key-prefix: workers
  dependency-hash: ${{ hashFiles('gradle/libs.versions.toml', '**/*.gradle.kts', 'buildSrc/**/*.kt', 'gradle/wrapper/gradle-wrapper.properties') }}
```

Include files that determine dependency and Gradle wrapper versions. If no custom hash is provided and none of the default patterns match, configuration validation fails. This helps catch missing checkout or incorrect project layouts.

## Local verification

With Python 3, Bash, `tar`, and `zstd` installed, run from the repository root:

```sh
bash -n gradle-deps-cache/cache.sh
python3 -m unittest discover -s gradle-deps-cache -p 'test_*.py' -v
```

The tests use real archive tools and a local AWS CLI stub. They do not contact S3 or require AWS credentials. The suite also runs in repository CI.
