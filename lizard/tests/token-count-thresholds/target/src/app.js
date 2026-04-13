function formatOrder(customerName, orderNumber, shippingRegion, couponCode) {
	const normalizedName = customerName.trim().toUpperCase();
	const regionLabel = shippingRegion.toLowerCase();
	const couponLabel = couponCode ? couponCode.toLowerCase() : "none";
	return `${normalizedName}:${orderNumber}:${regionLabel}:${couponLabel}`;
}
