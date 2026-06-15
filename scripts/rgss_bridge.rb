#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"

module RPGMTransRuntimeBridge
  module_function

  def install_runtime(root, script_file, engine, target_lang)
    scripts_file = find_scripts_file(root)
    return { "installed" => false, "reason" => "Scripts data file not found" } unless scripts_file

    require "zlib"
    script_source = File.binread(script_file)
    script_source = script_source.gsub("__RPGMTRANS_ENGINE__", engine.to_s)
    script_source = script_source.gsub("__RPGMTRANS_TARGET_LANG__", target_lang.to_s)

    scripts = Marshal.load(File.binread(scripts_file))
    scripts = [] unless scripts.is_a?(Array)
    scripts.reject! { |section| section.is_a?(Array) && section[1].to_s == "RPGMTransRuntime" }
    max_id = scripts.map { |section| section.is_a?(Array) ? section[0].to_i : 0 }.max || 0
    entry = [max_id + 1, "RPGMTransRuntime", Zlib::Deflate.deflate(script_source)]
    main_index = scripts.index { |section| section.is_a?(Array) && section[1].to_s.strip.downcase == "main" }
    main_index ? scripts.insert(main_index, entry) : scripts << entry
    File.binwrite(scripts_file, Marshal.dump(scripts))
    { "installed" => true, "file" => scripts_file }
  end

  def patch_acezon_f12(root)
    file = File.join(root, "Data", "Scripts.rvdata2")
    return { "patched" => false, "reason" => "Scripts.rvdata2 not found" } unless File.file?(file)

    require "zlib"
    scripts = Marshal.load(File.binread(file))
    changed = false
    scripts.each do |section|
      next unless section.is_a?(Array) && section[1].to_s =~ /Acezon.*F12/i
      source = Zlib::Inflate.inflate(section[2])
      next if source.include?("RPGMTransCompiler runtime patch: binary-safe window title")
      replacement = [
        "      # RPGMTransCompiler runtime patch: binary-safe window title",
        "      raw_title = str.dup",
        "      raw_title.force_encoding(\"ASCII-8BIT\") if raw_title.respond_to?(:force_encoding)",
        "      game_title = raw_title.delete(\"\\0\").strip"
      ].join("\n")
      patched = source.sub("      game_title = str.strip") { replacement }
      next if patched == source
      section[2] = Zlib::Deflate.deflate(patched)
      changed = true
    end
    File.binwrite(file, Marshal.dump(scripts)) if changed
    { "patched" => changed }
  end

  def dump_candidates(root, engine)
    prepare_rgss_classes
    root = root.to_s.tr("\\", "/")
    data_dir = File.join(root, "Data")
    return unless File.directory?(data_dir)

    Dir[File.join(data_dir, "*.{rxdata,rvdata,rvdata2}")].sort.each do |file|
      name = File.basename(file)
      next if name =~ /^Scripts\./i
      begin
        data = Marshal.load(File.binread(file))
      rescue => e
        STDERR.write("skip #{name}: #{e.class}: #{e.message}\n")
        next
      end
      candidates_for_file(engine, name, data).each do |candidate|
        STDOUT.write(JSON.generate(candidate))
        STDOUT.write("\n")
      end
    end
  end

  def candidates_for_file(engine, name, data)
    out = []
    base = name.sub(/\.(rxdata|rvdata|rvdata2)\z/i, "")
    case base
    when /^Map\d+/i
      add_candidate(out, engine, name, "$.@display_name", iv(data, :@display_name), "name", "display_name")
      events = iv(data, :@events)
      events.each do |event_id, event|
        pages = iv(event, :@pages) || []
        pages.each_with_index do |page, page_index|
          collect_event_commands(out, engine, name, "$.events[#{event_id}].pages[#{page_index}].list", iv(page, :@list))
        end
      end if events.respond_to?(:each)
    when "CommonEvents"
      each_data_item(data) do |event, index|
        collect_event_commands(out, engine, name, "$[#{index}].list", iv(event, :@list))
      end
    when "Troops"
      each_data_item(data) do |troop, troop_index|
        add_candidate(out, engine, name, "$[#{troop_index}].@name", iv(troop, :@name), "name", "name")
        (iv(troop, :@pages) || []).each_with_index do |page, page_index|
          collect_event_commands(out, engine, name, "$[#{troop_index}].pages[#{page_index}].list", iv(page, :@list))
        end
      end
    when "System"
      add_candidate(out, engine, name, "$.@game_title", iv(data, :@game_title), "system_term", "game_title")
      add_candidate(out, engine, name, "$.@currency_unit", iv(data, :@currency_unit), "system_term", "currency_unit")
      collect_rgss_terms(out, engine, name, data)
    when "MapInfos"
      if data.respond_to?(:each)
        data.each { |map_id, info| add_candidate(out, engine, name, "$[#{map_id}].@name", iv(info, :@name), "name", "name") }
      end
    else
      fields_for_database(base).each do |field_name, hint|
        each_data_item(data) do |item, index|
          add_candidate(out, engine, name, "$[#{index}].#{field_name}", iv(item, :"@#{field_name}"), hint, field_name)
        end
      end
    end
    out
  end

  def collect_event_commands(out, engine, file, base_path, list)
    return unless list.respond_to?(:each)

    message_lines = []
    scroll_lines = []
    flush_messages = lambda do
      if message_lines.length > 1
        source = message_lines.map { |item| item[:text] }.join("\n")
        source += "\n" if engine.to_s =~ /\A(?:XP|VX|VXA)\z/i
        add_candidate(out, engine, file, "#{base_path}[#{message_lines.first[:index]}..#{message_lines.last[:index]}]", source, "dialogue", "message", 401)
      end
      message_lines.clear
    end
    flush_scroll = lambda do
      if scroll_lines.length > 0
        source = scroll_lines.map { |item| item[:text] }.join("\n")
        source += "\n" if engine.to_s =~ /\A(?:XP|VX|VXA)\z/i
        add_candidate(out, engine, file, "#{base_path}[#{scroll_lines.first[:index]}..#{scroll_lines.last[:index]}]", source, "dialogue", "scroll", 405)
      end
      scroll_lines.clear
    end

    list.each_with_index do |command, index|
      code = iv(command, :@code).to_i
      params = iv(command, :@parameters) || []
      flush_messages.call unless code == 401
      flush_scroll.call unless code == 405

      case code
      when 401
        text = params[0].to_s
        message_lines << { :text => text, :index => index }
        add_candidate(out, engine, file, "#{base_path}[#{index}].parameters[0]", text, "dialogue", "message", code)
      when 102
        choices = params[0]
        choices.each_with_index do |choice, choice_index|
          add_candidate(out, engine, file, "#{base_path}[#{index}].parameters[0][#{choice_index}]", choice, "choice", "choice", code)
        end if choices.respond_to?(:each)
      when 405
        text = params[0].to_s
        scroll_lines << { :text => text, :index => index }
        add_candidate(out, engine, file, "#{base_path}[#{index}].parameters[0]", text, "dialogue", "scroll", code)
      end
    end
    flush_messages.call
    flush_scroll.call
  end

  def collect_rgss_terms(out, engine, file, system)
    terms = iv(system, :@terms)
    return unless terms
    [:@basic, :@params, :@etypes, :@commands].each do |field|
      value = iv(terms, field)
      value.each_with_index do |text, index|
        add_candidate(out, engine, file, "$.@terms.#{field}[#{index}]", text, "system_term", field.to_s.delete("@"))
      end if value.respond_to?(:each_with_index)
    end
  end

  def fields_for_database(base)
    case base
    when "Actors"
      [["name", "name"], ["nickname", "name"], ["profile", "description"]]
    when "Classes", "Enemies"
      [["name", "name"]]
    when "Skills"
      [["name", "name"], ["description", "description"], ["message1", "description"], ["message2", "description"]]
    when "Items", "Weapons", "Armors"
      [["name", "name"], ["description", "description"]]
    when "States"
      [["name", "name"], ["message1", "description"], ["message2", "description"], ["message3", "description"], ["message4", "description"]]
    else
      []
    end
  end

  def add_candidate(out, engine, file, path, source, semantic_hint, field_name, command_code = nil)
    return unless safe_text?(source)
    out << {
      "engine" => engine.to_s,
      "source" => source.to_s,
      "semanticHint" => semantic_hint,
      "file" => File.join("Data", file).tr("\\", "/"),
      "path" => path,
      "context" => {
        "origin" => "pretranslate",
        "file" => File.join("Data", file).tr("\\", "/"),
        "path" => path,
        "fieldName" => field_name,
        "commandCode" => command_code
      }.delete_if { |_key, value| value.nil? },
      "commandCode" => command_code,
      "fieldName" => field_name
    }.delete_if { |_key, value| value.nil? }
  end

  def safe_text?(source)
    return false unless source.is_a?(String)
    text = source.strip
    return false if text.empty?
    return false if text =~ /\A<[^>\n]+>\z/
    return false if text =~ /\A[A-Za-z0-9_.\/\\:-]+\.(png|jpg|jpeg|webp|ogg|m4a|mp3|wav|json|js)\z/i
    return false if text =~ /\A[A-Za-z0-9_.\/\\:-]+\z/ && text =~ /[.\/\\]/
    true
  end

  def each_data_item(data)
    return unless data.respond_to?(:each_with_index)
    data.each_with_index do |item, index|
      next if item.nil?
      yield item, index
    end
  end

  def iv(object, name)
    object.instance_variable_get(name) if object && object.instance_variable_defined?(name)
  end

  def prepare_rgss_classes
    Object.const_set("RPG", Module.new) unless Object.const_defined?("RPG", false)
    ensure_class("RPG::BaseItem")
    ensure_class("RPG::BaseItem::Feature")
    ensure_class("RPG::UsableItem", RPG::BaseItem)
    ensure_class("RPG::UsableItem::Effect")
    ensure_class("RPG::UsableItem::Damage")
    ensure_class("RPG::Skill", RPG::UsableItem)
    ensure_class("RPG::Item", RPG::UsableItem)
    ensure_class("RPG::EquipItem", RPG::BaseItem)
    ensure_class("RPG::Weapon", RPG::EquipItem)
    ensure_class("RPG::Armor", RPG::EquipItem)
    %w[
      RPG::Map RPG::Event RPG::MoveRoute RPG::MoveCommand RPG::EventCommand
      RPG::MapInfo RPG::Actor RPG::Class RPG::Enemy RPG::State RPG::Animation
      RPG::Tileset RPG::Troop RPG::System RPG::CommonEvent RPG::AudioFile
      RPG::BGM RPG::BGS RPG::ME RPG::SE RPG::Terms
      RPG::Event::Page RPG::Event::Page::Condition RPG::Event::Page::Graphic
      RPG::Troop::Page RPG::Troop::Page::Condition RPG::Troop::Member
      RPG::Animation::Frame RPG::Animation::Timing RPG::Enemy::DropItem
      RPG::Enemy::Action RPG::Class::Learning RPG::System::Vehicle
      RPG::System::Terms RPG::System::TestBattler
    ].each { |name| ensure_class(name) }
    prepare_dump_class("Table")
    prepare_dump_class("Color")
    prepare_dump_class("Tone")
  end

  def ensure_class(name, superclass = Object)
    parts = name.split("::")
    parent = Object
    parts.each_with_index do |part, index|
      if parent.const_defined?(part, false)
        parent = parent.const_get(part, false)
        next
      end
      klass = index == parts.length - 1 ? Class.new(superclass) : Class.new
      parent.const_set(part, klass)
      parent = klass
    end
    parent
  end

  def prepare_dump_class(name)
    klass = ensure_class(name)
    return if klass.respond_to?(:_load)
    klass.define_singleton_method(:_load) do |data|
      object = new
      object.instance_variable_set(:@raw, data)
      object
    end
  end

  def find_scripts_file(root)
    ["Scripts.rvdata2", "Scripts.rvdata", "Scripts.rxdata"].each do |name|
      file = File.join(root, "Data", name)
      return file if File.file?(file)
    end
    nil
  end
end

cmd = ARGV[0]
case cmd
when "install_runtime"
  root = ARGV[1] || abort("missing project root")
  script_file = ARGV[2] || abort("missing runtime script file")
  engine = ARGV[3] || abort("missing engine")
  target_lang = ARGV[4] || abort("missing target lang")
  STDOUT.write(JSON.generate(RPGMTransRuntimeBridge.install_runtime(root, script_file, engine, target_lang)))
when "patch_acezon_f12"
  root = ARGV[1] || abort("missing project root")
  STDOUT.write(JSON.generate(RPGMTransRuntimeBridge.patch_acezon_f12(root)))
when "dump_candidates"
  root = ARGV[1] || abort("missing project root")
  engine = ARGV[2] || abort("missing engine")
  RPGMTransRuntimeBridge.dump_candidates(root, engine)
else
  abort("usage: ruby rgss_bridge.rb install_runtime PROJECT_ROOT RUNTIME_SCRIPT ENGINE TARGET_LANG | patch_acezon_f12 PROJECT_ROOT | dump_candidates PROJECT_ROOT ENGINE")
end
