use crate::query::Query;

pub struct Handler;

impl Handler {
    pub fn run(&self, query: &Query) -> bool {
        self.validate(query)
    }

    fn validate(&self, _query: &Query) -> bool {
        true
    }
}
