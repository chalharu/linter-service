use crate::handler::Handler;

pub struct Query;

impl Query {
    pub fn process(&self, handler: &Handler) -> bool {
        handler.run(self)
    }
}
