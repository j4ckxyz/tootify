require 'active_record'

class Post < ActiveRecord::Base
  validates_presence_of :nostr_id, :bluesky_rkey

  validates_length_of :nostr_id, maximum: 64
  validates_length_of :bluesky_rkey, is: 13

  validates_uniqueness_of :bluesky_rkey
end
