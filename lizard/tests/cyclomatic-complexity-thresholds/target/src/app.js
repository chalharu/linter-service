function isReady(flags) {
	if (flags.a) {
		if (flags.b) {
			return true;
		}
	}
	if (flags.c) {
		return true;
	}
	return false;
}
