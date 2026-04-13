function renderNames(names) {
	const rendered = [];
	for (const name of names) {
		const normalized = name.trim();
		if (normalized.length > 0) {
			rendered.push(normalized.toUpperCase());
		}
	}
	return rendered.join(", ");
}
