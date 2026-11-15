/** Parse a comma-separated channel ID list into a Set (trimmed, empties dropped). */
export function parseChannelIds(value) {
    return new Set(
        (value ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
    );
}
