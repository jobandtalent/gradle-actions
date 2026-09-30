#!/usr/bin/env bash
set -euo pipefail

fail() {
    echo "::error::$*" >&2
    exit 1
}

warn() {
    echo "::warning::$*" >&2
}

case "${CACHE_MODE:-}" in
    lookup|restore|save) ;;
    *) fail "mode must be lookup, restore, or save" ;;
esac
[[ -n "${CACHE_BUCKET:-}" ]] || fail "aws-s3-bucket must be provided"
[[ "${RUNNER_OS:-}" == Linux && "${RUNNER_ARCH:-}" == X64 ]] || fail "gradle-deps-cache currently supports Linux x64 runners"

project_prefix="${CACHE_PROJECT_PREFIX:-${GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX:-}}"
# Keep exactly one separator before the action-owned namespace.
while [[ "$project_prefix" == */ ]]; do project_prefix="${project_prefix%/}"; done
[[ -n "$project_prefix" ]] || fail "Provide key-prefix or GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX"
[[ "${CACHE_DEPENDENCY_HASH:-}" =~ ^[a-zA-Z0-9._-]+$ ]] || fail "No valid dependency hash; check out the project or provide dependency-hash"

prefix="$project_prefix/gradle-deps/v1/"
key="$prefix$CACHE_DEPENDENCY_HASH.tar.zst"
gradle_user_home="${GRADLE_USER_HOME:-$HOME/.gradle}"
if [[ "$gradle_user_home" != /* ]]; then
    gradle_user_home="${GITHUB_WORKSPACE:?}/$gradle_user_home"
fi

work_dir=$(mktemp -d "${RUNNER_TEMP:?}/gradle-deps-cache.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT

if [[ -n "${CACHE_REGION:-}" ]]; then
    export AWS_REGION="$CACHE_REGION"
    export AWS_DEFAULT_REGION="$CACHE_REGION"
fi

if [[ "$CACHE_MODE" != lookup ]] && ! command -v zstd >/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq zstd
fi
if ! command -v aws >/dev/null; then
    curl -sSfL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o "$work_dir/awscliv2.zip"
    unzip -q "$work_dir/awscliv2.zip" -d "$work_dir"
    "$work_dir/aws/install" --install-dir "$work_dir/aws-cli" --bin-dir "$work_dir/bin"
    export PATH="$work_dir/bin:$PATH"
fi

echo "cache-hit=false" >> "${GITHUB_OUTPUT:?}"
echo "cache-exists=false" >> "$GITHUB_OUTPUT"
echo "Gradle dependencies cache: mode=$CACHE_MODE; bucket=$CACHE_BUCKET; key=$key; home=$gradle_user_home"
start=$(date +%s)

if [[ "$CACHE_MODE" == lookup ]]; then
    if aws s3api head-object --bucket "$CACHE_BUCKET" --key "$key" >/dev/null 2>"$work_dir/lookup-error"; then
        echo "cache-exists=true" >> "$GITHUB_OUTPUT"
        echo "Entry $key already exists; dependency warming can be skipped"
    else
        if ! grep -Eq '404|Not Found|NoSuchKey' "$work_dir/lookup-error"; then
            warn "Could not check Gradle dependencies cache entry; treating it as missing"
            cat "$work_dir/lookup-error" >&2
        fi
        echo "No confirmed entry for $key; dependency warming is needed"
    fi
    exit 0
fi

if [[ "$CACHE_MODE" == restore ]]; then
    exact_hit=false
    if aws s3api head-object --bucket "$CACHE_BUCKET" --key "$key" >/dev/null 2>&1; then
        restore_key="$key"
        exact_hit=true
    else
        echo "No exact entry; looking for the newest archive under $prefix"
        query="sort_by((Contents || \`[]\`)[?ends_with(Key, '.tar.zst')], &LastModified)[-1].Key"
        if ! restore_key=$(aws s3api list-objects-v2 --bucket "$CACHE_BUCKET" --prefix "$prefix" --query "$query" --output text); then
            warn "Could not list Gradle dependencies cache entries; continuing without restoring"
            exit 0
        fi
    fi

    if [[ -z "$restore_key" || "$restore_key" == None ]]; then
        echo "No Gradle dependencies cache entry found"
        exit 0
    fi
    if [[ "$restore_key" != "$prefix"*.tar.zst ]]; then
        warn "Unexpected cache key returned by S3; skipping restore"
        exit 0
    fi

    # Stage extraction so a failed download cannot damage an existing Gradle home.
    mkdir -p "$work_dir/restore"
    if ! aws s3 cp "s3://$CACHE_BUCKET/$restore_key" - --only-show-errors \
        | zstd -d -T0 \
        | tar -xf - -C "$work_dir/restore"; then
        warn "Gradle dependencies cache restore failed; continuing with existing local state"
        exit 0
    fi
    if [[ ! -d "$work_dir/restore/caches/modules-2" || ! -d "$work_dir/restore/wrapper/dists" ]]; then
        warn "Gradle dependencies cache archive is incomplete; skipping restore"
        exit 0
    fi

    mkdir -p "$gradle_user_home/caches" "$gradle_user_home/wrapper"
    rm -rf -- "$gradle_user_home/caches/modules-2" "$gradle_user_home/wrapper/dists"
    mv "$work_dir/restore/caches/modules-2" "$gradle_user_home/caches/"
    mv "$work_dir/restore/wrapper/dists" "$gradle_user_home/wrapper/"
    echo "cache-hit=$exact_hit" >> "$GITHUB_OUTPUT"
    echo "Restored $restore_key in $(( $(date +%s) - start ))s"
else
    if aws s3api head-object --bucket "$CACHE_BUCKET" --key "$key" >/dev/null 2>&1; then
        echo "Entry $key already exists; skipping save"
        exit 0
    fi
    if [[ ! -d "$gradle_user_home/caches/modules-2" || ! -d "$gradle_user_home/wrapper/dists" ]]; then
        warn "Gradle dependencies or wrapper distributions are missing; skipping save"
        exit 0
    fi

    # Exclude transient metadata without modifying the source directories.
    if ! tar -C "$gradle_user_home" --exclude='*.lock' --exclude='caches/modules-2/gc.properties' \
        -cf - caches/modules-2 wrapper/dists \
        | zstd -T0 -3 \
        | aws s3 cp - "s3://$CACHE_BUCKET/$key" --only-show-errors; then
        warn "Gradle dependencies cache save failed; continuing without saving"
        exit 0
    fi
    echo "Saved $key in $(( $(date +%s) - start ))s"
fi
