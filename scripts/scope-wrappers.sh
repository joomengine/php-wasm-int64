#!/usr/bin/env bash
# Restrict each independently downloadable artifact to its compiled PHP minor.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
select_php "${1:-}"
source_directory=${2:-"$UPSTREAM_DIRECTORY/source"}
[[ -d $source_directory ]] || die "Source wrapper directory does not exist: $source_directory"
wrappers=(PhpNode PhpWeb PhpWorker PhpWebview PhpCgiNode PhpCgiWeb PhpCgiWorker PhpCgiWebview PhpCliNode PhpCliWeb PhpDbgNode PhpDbgWeb)
for wrapper in "${wrappers[@]}"; do
  file="$source_directory/$wrapper.mjs"
  [[ -f $file ]] || die "Missing upstream wrapper: $file"
  awk -v minor="$PHP_MINOR" '
    /^const defaultVersion =/ {
      print "const defaultVersion = \047" minor "\047;";
      skip_default = ($0 !~ /;[[:space:]]*$/); next
    }
    skip_default { if ($0 ~ /;[[:space:]]*$/) skip_default = 0; next }
    /^[[:space:]]*case \0478\.[0-5]\047:/ {
      skip_case = (index($0, "\047" minor "\047") == 0)
    }
    skip_case { if ($0 ~ /^[[:space:]]*break;/) skip_case = 0; next }
    /^import Php[0-9]+CgiWorker from / {
      if (index($0, "php" minor "-cgi-worker.mjs")) print;
      next
    }
    /^const runtimes = \{/ {
      digits=minor; gsub(/\./,"",digits);
      print "const runtimes = {\047" minor "\047: Php" digits "CgiWorker};";
      skip_runtimes = 1; next
    }
    skip_runtimes { if ($0 ~ /^};/) skip_runtimes = 0; next }
    { print }
  ' "$file" > "$file.int64"
  mv -- "$file.int64" "$file"
  node --check "$file"
done
