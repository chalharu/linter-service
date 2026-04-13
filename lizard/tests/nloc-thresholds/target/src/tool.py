def describe_value(value):
    if value is None:
        return "none"
    if value == 0:
        return "zero"
    return f"value={value}"
