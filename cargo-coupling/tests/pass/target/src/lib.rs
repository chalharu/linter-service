pub trait Store {
    fn save(&self, value: &str);
}

pub struct Service<T: Store> {
    store: T,
}

impl<T: Store> Service<T> {
    pub fn new(store: T) -> Self {
        Self { store }
    }

    pub fn save(&self, value: &str) {
        self.store.save(value);
    }
}
