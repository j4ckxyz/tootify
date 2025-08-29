require 'yaml'
require 'nostr_ruby'
require 'openssl'
require 'base64'
require 'net/http'
require 'json'
require 'uri'

class NostrAccount
  CONFIG_FILE = File.expand_path(File.join(__dir__, '..', 'config', 'nostr.yml'))

  def initialize
    @config = File.exist?(CONFIG_FILE) ? YAML.load(File.read(CONFIG_FILE)) : {}
  end

  def save_config
    File.write(CONFIG_FILE, YAML.dump(@config))
  end

  def login_with_nsec(nsec)
    print 'Encryption password: '
    password = STDIN.noecho(&:gets).chomp
    puts
    @config['nsec'] = encrypt(nsec, password)
    save_config
  end

  def relay_urls
    @config['relays'] || ['wss://relay.damus.io']
  end

  def blossom_server
    @config['blossom']
  end

  def post_status(text, attachment_urls = [], parent_id = nil)
    nsec = decrypt_nsec
    private_key = Nostr::Bech32.decode(nsec)[:data]

    tags = []
    attachment_urls.each { |u| tags << ['r', u] }
    tags << ['e', parent_id] if parent_id

    event = Nostr::Event.new(kind: Nostr::Kind::SHORT_NOTE, content: text, tags: tags)
    signer = Nostr::Signer.new(private_key: private_key)
    signer.sign(event)

    relay_urls.each do |url|
      client = Nostr::Client.new(signer: signer, relay: url)
      client.connect
      client.publish_and_wait(event, close_on_finish: true)
    end

    { 'id' => event.id }
  end

  def upload_media(data, filename, content_type)
    return nil unless blossom_server

    url = URI.join(blossom_server, '/upload')
    request = Net::HTTP::Post.new(url)
    form_data = [['file', data, { filename: filename, content_type: content_type }]]
    request.set_form(form_data, 'multipart/form-data')
    response = Net::HTTP.start(url.hostname, url.port, use_ssl: url.scheme == 'https') do |http|
      http.request(request)
    end
    if response.code.to_i / 100 == 2
      json = JSON.parse(response.body)
      json['url']
    else
      nil
    end
  end

  private

  def encrypt(data, password)
    cipher = OpenSSL::Cipher.new('aes-256-cbc')
    cipher.encrypt
    cipher.key = OpenSSL::Digest::SHA256.digest(password)
    iv = cipher.random_iv
    cipher.iv = iv
    encrypted = cipher.update(data) + cipher.final
    Base64.strict_encode64(iv + encrypted)
  end

  def decrypt_nsec
    encrypted = @config['nsec'] or raise 'No Nostr key stored'
    password = ENV['NSEC_PASSPHRASE'] || ''
    raw = Base64.decode64(encrypted)
    iv = raw[0...16]
    data = raw[16..]
    cipher = OpenSSL::Cipher.new('aes-256-cbc')
    cipher.decrypt
    cipher.iv = iv
    cipher.key = OpenSSL::Digest::SHA256.digest(password)
    cipher.update(data) + cipher.final
  end
end
