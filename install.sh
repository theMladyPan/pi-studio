#!/bin/sh
# pi-studio bootstrap installer.
#
#   curl -fsSL https://github.com/theMladyPan/pi-studio/releases/latest/download/install.sh | sh
#
# This file downloads the one release it names, verifies its checksum, extracts it into a private
# temporary folder, and hands the verified tree to the same manager the app updates itself with
# (`bin/manage.mjs`, `installFromDir`). It never runs npm, git or sudo, never edits your shell
# profile, and never touches a state folder, a source clone, Node or pi.
#
# Only POSIX sh, curl, tar and an external Node >= 22.18 are used. Node, git and pi are checked;
# missing ones are reported with guidance instead of being installed for you.
#
# Environment (all optional):
#   PI_STUDIO_INSTALL_ROOT       where versions live (default: $XDG_DATA_HOME/pi-studio, else
#                                ~/.local/share/pi-studio)
#   PI_STUDIO_BIN_DIR            where the launcher goes (default: ~/.local/bin)
#   PI_STUDIO_STATE              the global state folder (default: $XDG_STATE_HOME/pi-studio,
#                                else ~/.local/state/pi-studio)
#   PI_STUDIO_RELEASE_BASE_URL   release download base. https only; http is accepted for a
#                                loopback host as an explicit test fixture, nothing else.
#
# Flags: --help, --version, --replace-custom
#
# `npm run package` writes the published copy of this file, with the version token below filled
# in. Run this repository copy straight from a checkout and it refuses, because it names no
# version to install.
#
# Every step lives in a function and main() is the last line, so a truncated download fails to
# parse before anything is downloaded, extracted or installed.

PI_STUDIO_REPO_URL="https://github.com/theMladyPan/pi-studio"
PI_STUDIO_RELEASE_BASE_URL_DEFAULT="$PI_STUDIO_REPO_URL/releases/download"
PI_STUDIO_MIN_NODE_MAJOR=22
PI_STUDIO_MIN_NODE_MINOR=18
PI_STUDIO_VERSION='@@PI_STUDIO_VERSION@@'

# Two programs handed to node: the release's own verifier and the staged install entry. They are
# single-quoted, so sh expands nothing inside them; neither contains a single quote.
PI_STUDIO_CHECKSUM_JS='
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [checksumFile, archiveName, archiveFile] = process.argv.slice(1);
const lines = String(readFileSync(checksumFile, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean);
const found = lines.map((line) => /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)).find((match) => match && match[2] === archiveName);
if (!found) {
	console.error("pi-studio: " + checksumFile + " does not name " + archiveName);
	process.exit(1);
}
const expected = found[1].toLowerCase();
const actual = createHash("sha256").update(readFileSync(archiveFile)).digest("hex");
if (actual !== expected) {
	console.error("pi-studio: checksum mismatch for " + archiveName + ": expected " + expected + ", got " + actual);
	process.exit(1);
}
'

PI_STUDIO_INSTALL_JS='
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const [appDir, consent, version] = process.argv.slice(1);
const manager = await import(pathToFileURL(join(appDir, "bin", "manage.mjs")).href);
const runtime = await import(pathToFileURL(join(appDir, "bin", "runtime.mjs")).href);
const flags = {};
if (consent === "1") flags["replace-custom"] = true;

try {
	const identity = JSON.parse(readFileSync(join(appDir, "build.json"), "utf8"));
	if (identity.version !== version) {
		throw new Error("pi-studio: the archive holds " + identity.version + ", and this installer names " + version + ", so it was not installed");
	}
	const installed = manager.installedIdentity(runtime.installRootDir(flags));
	if (installed && installed.identity.custom && !flags["replace-custom"]) {
		throw new Error(
			"pi-studio: the installed copy is a custom build (" + installed.identity.version + "); pass --replace-custom to put this release in its place",
		);
	}
	const result = manager.installFromDir(appDir, flags);
	const onPath = String(process.env.PATH || "").split(delimiter);
	if (!onPath.includes(result.binDir)) {
		console.log("pi-studio: " + result.binDir + " is not on PATH, so the pi-studio command will not be found. Add it yourself, for example: export PATH=\"" + result.binDir + ":$PATH\"");
	}
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
'

say() {
	printf '%s\n' "pi-studio: $*"
}

warn() {
	printf '%s\n' "pi-studio: $*" >&2
}

die() {
	printf '%s\n' "pi-studio: $*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
pi-studio bootstrap installer.

Usage: install.sh [--replace-custom] [--version] [--help]

Downloads the release this file belongs to, verifies it, and installs it as a per-user copy.
Nothing is downloaded with npm, git or sudo, and no shell profile is edited.

Flags:
  --replace-custom   allow replacing an installed custom build with this official release
  --version          print the release version this file installs
  --help             this text

Install roots come from the environment: PI_STUDIO_INSTALL_ROOT, PI_STUDIO_BIN_DIR,
PI_STUDIO_STATE, and PI_STUDIO_RELEASE_BASE_URL for a test download base.

After installing, run: pi-studio
EOF
}

cleanup() {
	case ${pi_studio_tmp:-} in
		"${TMPDIR:-/tmp}/pi-studio-install."*) rm -rf "$pi_studio_tmp" ;;
	esac
}

parse_args() {
	opt_replace_custom=0
	while [ $# -gt 0 ]; do
		case $1 in
			-h | --help)
				usage
				exit 0
				;;
			-V | --version)
				check_version
				printf '%s\n' "$PI_STUDIO_VERSION"
				exit 0
				;;
			--replace-custom) opt_replace_custom=1 ;;
			*)
				die "unknown argument: $1 (supported: --help, --version, --replace-custom; install roots come from PI_STUDIO_* variables)"
				;;
		esac
		shift
	done
}

check_version() {
	case $PI_STUDIO_VERSION in
		'' | *[!0-9.]*)
			die "this is the unexpanded installer template from the repository, so it names no release to install. Download the published installer instead: $PI_STUDIO_REPO_URL/releases/latest/download/install.sh"
			;;
	esac
}

resolve_release_base() {
	release_base=${PI_STUDIO_RELEASE_BASE_URL:-$PI_STUDIO_RELEASE_BASE_URL_DEFAULT}
	while :; do
		case $release_base in
			*/) release_base=${release_base%/} ;;
			*) break ;;
		esac
	done
	case $release_base in
		https://?*) ;;
		http://?*)
			hostport=${release_base#http://}
			hostport=${hostport%%/*}
			case $hostport in
				127.* | localhost | localhost:* | \[::1\] | \[::1\]:*) ;;
				*) die "refusing $release_base: http:// is only allowed for an explicit loopback test fixture, and https:// for everything else" ;;
			esac
			;;
		*) die "refusing $release_base: the release base URL must start with https://" ;;
	esac
}

check_node() {
	command -v node >/dev/null 2>&1 ||
		die "Node >= $PI_STUDIO_MIN_NODE_MAJOR.$PI_STUDIO_MIN_NODE_MINOR is required and is not on PATH. Install an official build from https://nodejs.org or with a version manager, then run this again. Nothing was installed."
	node_version=$(node -p "process.versions.node" 2>/dev/null) ||
		die "cannot run the node found at $(command -v node); pi-studio needs Node >= $PI_STUDIO_MIN_NODE_MAJOR.$PI_STUDIO_MIN_NODE_MINOR. Nothing was installed."
	node_major=${node_version%%.*}
	node_rest=${node_version#*.}
	node_minor=${node_rest%%.*}
	case $node_major$node_minor in
		'' | *[!0-9]*) die "cannot read the Node version: $node_version. Nothing was installed." ;;
	esac
	if [ "$node_major" -gt "$PI_STUDIO_MIN_NODE_MAJOR" ]; then
		return 0
	fi
	if [ "$node_major" -eq "$PI_STUDIO_MIN_NODE_MAJOR" ] && [ "$node_minor" -ge "$PI_STUDIO_MIN_NODE_MINOR" ]; then
		return 0
	fi
	die "Node >= $PI_STUDIO_MIN_NODE_MAJOR.$PI_STUDIO_MIN_NODE_MINOR is required, and $(command -v node) is $node_version. Put an official Node build ahead of it on PATH (a distribution build often cannot run pi-studio even when the version passes), then run this again. Nothing was installed."
}

check_requirements() {
	if ! command -v git >/dev/null 2>&1; then
		warn "git is not on PATH. The board's git features need it: install git from https://git-scm.com/downloads and reopen your shell. Installing pi-studio anyway."
	fi
	if ! command -v pi >/dev/null 2>&1; then
		warn "pi is not on PATH. pi-studio starts the pi coding agent for every thread, so threads cannot run until pi is installed and on PATH. Installing pi-studio anyway."
	fi
}

download() {
	# download <url> <destination>
	if ! curl -fsSL --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 --retry-delay 1 -o "$2" "$1"; then
		die "download failed: $1. Nothing was installed."
	fi
}

verify_checksum() {
	if ! node --input-type=module -e "$PI_STUDIO_CHECKSUM_JS" "$checksum_file" "$archive_name" "$archive_file"; then
		die "the release archive was not verified, so it was not extracted. Nothing was installed."
	fi
}

validate_archive() {
	# The archive is checksum-verified already; this refuses anything a release never holds:
	# absolute or escaping paths, and link or special entries, before tar writes a single file.
	tar -tzf "$archive_file" >"$pi_studio_tmp/listing.txt" ||
		die "the downloaded file is not a readable tar.gz archive. Nothing was installed."
	tar -tvzf "$archive_file" >"$pi_studio_tmp/types.txt" ||
		die "the downloaded file is not a readable tar.gz archive. Nothing was installed."
	archive_top=''
	while IFS= read -r entry; do
		[ -n "$entry" ] || continue
		case $entry in
			/*) die "the archive holds an absolute path, which a release never does: $entry. Nothing was installed." ;;
			../* | */../* | */.. | ..) die "the archive holds a path that escapes its folder: $entry. Nothing was installed." ;;
			*\\*) die "the archive holds a path with a backslash in it: $entry. Nothing was installed." ;;
		esac
		first=${entry%%/*}
		if [ -z "$archive_top" ]; then
			archive_top=$first
		elif [ "$first" != "$archive_top" ]; then
			die "the archive does not hold exactly one top-level folder: $entry. Nothing was installed."
		fi
	done <"$pi_studio_tmp/listing.txt"
	[ -n "$archive_top" ] || die "the downloaded archive is empty. Nothing was installed."
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		case $line in
			[-d]*) ;;
			*) die "the archive holds a link or special entry, which a release never does: $line. Nothing was installed." ;;
		esac
	done <"$pi_studio_tmp/types.txt"
}

extract_archive() {
	app_dir=$pi_studio_tmp/$archive_top
	# The extraction stays inside the private temporary folder; no release path points outside it.
	if ! (umask 022 && tar -xzf "$archive_file" -C "$pi_studio_tmp"); then
		die "cannot extract the downloaded archive. Nothing was installed."
	fi
	[ -d "$app_dir" ] && [ ! -L "$app_dir" ] ||
		die "the archive's top-level entry is not a plain folder: $archive_top. Nothing was installed."
	find "$pi_studio_tmp" \( -type l -o -type p -o -type s -o -type b -o -type c \) -print >"$pi_studio_tmp/entries.txt"
	if [ -s "$pi_studio_tmp/entries.txt" ]; then
		die "the extracted tree holds a link or special file, which a release never does. Nothing was installed."
	fi
	for required in package.json build.json bin/pi-studio; do
		[ -f "$app_dir/$required" ] || die "the downloaded archive is missing $required. Nothing was installed."
	done
}

run_install() {
	if [ "$opt_replace_custom" = 1 ]; then
		consent=1
	else
		consent=0
	fi
	if ! node --input-type=module -e "$PI_STUDIO_INSTALL_JS" "$app_dir" "$consent" "$PI_STUDIO_VERSION"; then
		die "the install did not complete. Anything already installed is unchanged."
	fi
}

main() {
	parse_args "$@"
	check_version
	resolve_release_base
	check_node
	check_requirements

	archive_name="pi-studio-$PI_STUDIO_VERSION.tar.gz"
	release_url="$release_base/v$PI_STUDIO_VERSION"
	say "installing $PI_STUDIO_VERSION from $release_url"
	pi_studio_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-studio-install.XXXXXX") ||
		die "cannot create a temporary folder under ${TMPDIR:-/tmp}. Nothing was installed."
	checksum_file=$pi_studio_tmp/$archive_name.sha256
	archive_file=$pi_studio_tmp/$archive_name

	download "$release_url/$archive_name.sha256" "$checksum_file"
	download "$release_url/$archive_name" "$archive_file"
	verify_checksum
	validate_archive
	extract_archive
	run_install
	say "done: pi-studio $PI_STUDIO_VERSION is installed"
}

trap cleanup 0
trap 'exit 1' HUP INT TERM
main "$@"
