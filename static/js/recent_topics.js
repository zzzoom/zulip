import render_recent_topic_row from "../templates/recent_topic_row.hbs";
import render_recent_topics_filters from "../templates/recent_topics_filters.hbs";
import render_recent_topics_body from "../templates/recent_topics_table.hbs";

import * as compose_actions from "./compose_actions";
import * as drafts from "./drafts";
import * as hash_util from "./hash_util";
import * as ListWidget from "./list_widget";
import {localstorage} from "./localstorage";
import * as message_store from "./message_store";
import * as message_util from "./message_util";
import * as message_view_header from "./message_view_header";
import * as muting from "./muting";
import * as narrow from "./narrow";
import * as narrow_state from "./narrow_state";
import * as navigate from "./navigate";
import * as panels from "./panels";
import * as people from "./people";
import * as recent_senders from "./recent_senders";
import * as stream_data from "./stream_data";
import * as stream_list from "./stream_list";
import * as timerender from "./timerender";
import * as top_left_corner from "./top_left_corner";
import * as unread from "./unread";

const topics = new Map(); // Key is stream-id:topic.
let topics_widget;
// Sets the number of avatars to display.
// Rest of the avatars, if present, are displayed as {+x}
const MAX_AVATAR = 4;

// Use this to set the focused element.
//
// We set it's value to `table` in case the
// focus in one of the table rows, since the
// table rows are constantly updated and tracking
// the selected element in them would be tedious via
// jquery.
//
// So, we use table as a grid system and
// track the coordinates of the focus element via
// `row_focus` and `col_focus`.
let current_focus_elem = "table";
let row_focus = 0;
// Start focus on the topic column, so Down+Enter works to visit a topic.
let col_focus = 1;

// The number of selectable actions in a recent_topics.  Used to
// implement wraparound of elements with the right/left keys.  Must be
// increased when we add new actions, or rethought if we add optional
// actions that only appear in some rows.
const MAX_SELECTABLE_COLS = 4;

// we use localstorage to persist the recent topic filters
const ls_key = "recent_topic_filters";
const ls = localstorage();

let filters = new Set();

export function clear_for_tests() {
    filters.clear();
    topics.clear();
    topics_widget = undefined;
}

export function save_filters() {
    ls.set(ls_key, Array.from(filters));
}

export function load_filters() {
    filters = new Set(ls.get(ls_key));
}

export function set_default_focus() {
    // If at any point we are confused about the currently
    // focused element, we switch focus to search.
    current_focus_elem = $("#recent_topics_search");
    current_focus_elem.trigger("focus");
}

function set_table_focus(row, col) {
    const topic_rows = $("#recent_topics_table table tbody tr");
    if (topic_rows.length === 0 || row < 0 || row >= topic_rows.length) {
        row_focus = 0;
        // return focus back to filters if we cannot focus on the table.
        set_default_focus();
        return true;
    }

    // Setting focus after the render is complete doesn't partially hide the row from view.
    setTimeout(() => {
        topic_rows.eq(row).find(".recent_topics_focusable").eq(col).children().trigger("focus");
    }, 0);
    current_focus_elem = "table";
    return true;
}

function revive_current_focus() {
    // After re-render, the current_focus_elem is no longer linked
    // to the focused element, this function attempts to revive the
    // link and focus to the element prior to the rerender.

    // Don't change focus if user is trying to type anywhere.
    if ($(".home-page-input").is(":focus")) {
        return false;
    }

    if (!current_focus_elem) {
        set_default_focus();
        return false;
    }

    if (current_focus_elem === "table") {
        set_table_focus(row_focus, col_focus);
        return true;
    }

    const filter_button = current_focus_elem.data("filter");
    if (!filter_button) {
        set_default_focus();
    } else {
        current_focus_elem = $("#recent_topics_filter_buttons").find(
            `[data-filter='${CSS.escape(filter_button)}']`,
        );
        current_focus_elem.trigger("focus");
    }
    return true;
}

function get_topic_key(stream_id, topic) {
    return stream_id + ":" + topic.toLowerCase();
}

export function process_messages(messages) {
    // FIX: Currently, we do a complete_rerender every time
    // we process a new message.
    // While this is inexpensive and handles all the cases itself,
    // the UX can be bad if user wants to scroll down the list as
    // the UI will be returned to the beginning of the list on every
    // update.
    for (const msg of messages) {
        process_message(msg);
    }
    complete_rerender();
}

export function process_message(msg) {
    if (msg.type !== "stream") {
        return false;
    }
    // Initialize topic data
    const key = get_topic_key(msg.stream_id, msg.topic);
    if (!topics.has(key)) {
        topics.set(key, {
            last_msg_id: -1,
            participated: false,
        });
    }
    // Update topic data
    const is_ours = people.is_my_user_id(msg.sender_id);
    const topic_data = topics.get(key);
    if (topic_data.last_msg_id < msg.id) {
        // NOTE: This also stores locally echoed msg_id which
        // has not been successfully received from the server.
        // We store it now and reify it when response is available
        // from server.
        topic_data.last_msg_id = msg.id;
    }
    // TODO: Add backend support for participated topics.
    // Currently participated === recently participated
    // i.e. Only those topics are participated for which we have the user's
    // message fetched in the topic. Ideally we would want this to be attached
    // to topic info fetched from backend, which is currently not a thing.
    topic_data.participated = is_ours || topic_data.participated;
    return true;
}

export function reify_message_id_if_available(opts) {
    // We don't need to reify the message_id of the topic
    // if a new message arrives in the topic from another user,
    // since it replaces the last_msg_id of the topic which
    // we were trying to reify.
    for (const [, value] of topics.entries()) {
        if (value.last_msg_id === opts.old_id) {
            value.last_msg_id = opts.new_id;
            return true;
        }
    }
    return false;
}

function get_sorted_topics() {
    // Sort all recent topics by last message time.
    return new Map(
        Array.from(topics.entries()).sort((a, b) => b[1].last_msg_id - a[1].last_msg_id),
    );
}

export function get() {
    return get_sorted_topics();
}

function format_topic(topic_data) {
    const last_msg = message_store.get(topic_data.last_msg_id);
    const stream = last_msg.stream;
    const stream_id = last_msg.stream_id;
    const stream_info = stream_data.get_sub_by_id(stream_id);
    if (stream_info === undefined) {
        // stream was deleted
        return {};
    }
    const topic = last_msg.topic;
    const time = new Date(last_msg.timestamp * 1000);
    const last_msg_time = timerender.last_seen_status_from_date(time);
    const full_datetime = timerender.get_full_datetime(time);

    // We hide the row according to filters or if it's muted.
    // We only supply the data to the topic rows and let jquery
    // display / hide them according to filters instead of
    // doing complete re-render.
    const topic_muted = Boolean(muting.is_topic_muted(stream_id, topic));
    const stream_muted = stream_data.is_muted(stream_id);
    const muted = topic_muted || stream_muted;
    const unread_count = unread.num_unread_for_topic(stream_id, topic);

    // Display in most recent sender first order
    const all_senders = recent_senders.get_topic_recent_senders(stream_id, topic);
    const senders = all_senders.slice(-MAX_AVATAR);
    const senders_info = people.sender_info_with_small_avatar_urls_for_sender_ids(senders);

    return {
        // stream info
        stream_id,
        stream,
        stream_color: stream_info.color,
        invite_only: stream_info.invite_only,
        is_web_public: stream_info.is_web_public,
        stream_url: hash_util.by_stream_uri(stream_id),

        topic,
        topic_key: get_topic_key(stream_id, topic),
        unread_count,
        last_msg_time,
        topic_url: hash_util.by_stream_topic_uri(stream_id, topic),
        senders: senders_info,
        other_senders_count: Math.max(0, all_senders.length - MAX_AVATAR),
        muted,
        topic_muted,
        participated: topic_data.participated,
        full_last_msg_date_time: full_datetime.date + " " + full_datetime.time,
    };
}

function get_topic_row(topic_data) {
    const msg = message_store.get(topic_data.last_msg_id);
    const topic_key = get_topic_key(msg.stream_id, msg.topic);
    return $(`#${CSS.escape("recent_topic:" + topic_key)}`);
}

export function process_topic_edit(old_stream_id, old_topic, new_topic, new_stream_id) {
    // See `recent_senders.process_topic_edit` for
    // logic behind this and important notes on use of this function.
    topics.delete(get_topic_key(old_stream_id, old_topic));

    const old_topic_msgs = message_util.get_messages_in_topic(old_stream_id, old_topic);
    process_messages(old_topic_msgs);

    new_stream_id = new_stream_id || old_stream_id;
    const new_topic_msgs = message_util.get_messages_in_topic(new_stream_id, new_topic);
    process_messages(new_topic_msgs);
}

export function topic_in_search_results(keyword, stream, topic) {
    if (keyword === "") {
        return true;
    }
    const text = (stream + " " + topic).toLowerCase();
    const search_words = keyword.toLowerCase().split(/\s+/);
    return search_words.every((word) => text.includes(word));
}

export function update_topics_of_deleted_message_ids(message_ids) {
    const topics_to_rerender = message_util.get_topics_for_message_ids(message_ids);

    for (const [stream_id, topic] of topics_to_rerender.values()) {
        topics.delete(get_topic_key(stream_id, topic));
        const msgs = message_util.get_messages_in_topic(stream_id, topic);
        process_messages(msgs);
    }
}

export function filters_should_hide_topic(topic_data) {
    const msg = message_store.get(topic_data.last_msg_id);
    const sub = stream_data.get_sub_by_id(msg.stream_id);

    if (sub === undefined || !sub.subscribed) {
        // Never try to process deactivated & unsubscribed stream msgs.
        return true;
    }

    if (filters.has("unread")) {
        const unreadCount = unread.num_unread_for_topic(msg.stream_id, msg.topic);
        if (unreadCount === 0) {
            return true;
        }
    }

    if (!topic_data.participated && filters.has("participated")) {
        return true;
    }

    if (!filters.has("include_muted")) {
        const topic_muted = Boolean(muting.is_topic_muted(msg.stream_id, msg.topic));
        const stream_muted = stream_data.is_muted(msg.stream_id);
        if (topic_muted || stream_muted) {
            return true;
        }
    }

    const search_keyword = $("#recent_topics_search").val();
    if (!topic_in_search_results(search_keyword, msg.stream, msg.topic)) {
        return true;
    }

    return false;
}

export function inplace_rerender(topic_key) {
    if (!is_visible()) {
        return false;
    }
    if (!topics.has(topic_key)) {
        return false;
    }

    const topic_data = topics.get(topic_key);
    topics_widget.render_item(topic_data);
    const topic_row = get_topic_row(topic_data);

    if (filters_should_hide_topic(topic_data)) {
        topic_row.hide();
    } else {
        topic_row.show();
    }
    revive_current_focus();
    return true;
}

export function update_topic_is_muted(stream_id, topic) {
    const key = get_topic_key(stream_id, topic);
    if (!topics.has(key)) {
        // we receive mute request for a topic we are
        // not tracking currently
        return false;
    }

    inplace_rerender(key);
    return true;
}

export function update_topic_unread_count(message) {
    const topic_key = get_topic_key(message.stream_id, message.topic);
    inplace_rerender(topic_key);
}

export function set_filter(filter) {
    // This function updates the `filters` variable
    // after user clicks on one of the filter buttons
    // based on `btn-recent-selected` class and current
    // set `filters`.

    // Get the button which was clicked.
    const filter_elem = $("#recent_topics_filter_buttons").find(
        `[data-filter="${CSS.escape(filter)}"]`,
    );

    // If user clicks `All`, we clear all filters.
    if (filter === "all" && filters.size !== 0) {
        filters = new Set();
        // If the button was already selected, remove the filter.
    } else if (filter_elem.hasClass("btn-recent-selected")) {
        filters.delete(filter);
        // If the button was not selected, we add the filter.
    } else {
        filters.add(filter);
    }

    save_filters();
}

function show_selected_filters() {
    // Add `btn-selected-filter` to the buttons to show
    // which filters are applied.
    load_filters();
    if (filters.size === 0) {
        $("#recent_topics_filter_buttons")
            .find('[data-filter="all"]')
            .addClass("btn-recent-selected");
    } else {
        for (const filter of filters) {
            $("#recent_topics_filter_buttons")
                .find(`[data-filter="${CSS.escape(filter)}"]`)
                .addClass("btn-recent-selected");
        }
    }
}

export function update_filters_view() {
    const rendered_filters = render_recent_topics_filters({
        filter_participated: filters.has("participated"),
        filter_unread: filters.has("unread"),
        filter_muted: filters.has("include_muted"),
    });
    $("#recent_filters_group").html(rendered_filters);
    show_selected_filters();

    topics_widget.hard_redraw();
}

function stream_sort(a, b) {
    const a_stream = message_store.get(a.last_msg_id).stream;
    const b_stream = message_store.get(b.last_msg_id).stream;
    if (a_stream > b_stream) {
        return 1;
    } else if (a_stream === b_stream) {
        return 0;
    }
    return -1;
}

function topic_sort(a, b) {
    const a_topic = message_store.get(a.last_msg_id).topic;
    const b_topic = message_store.get(b.last_msg_id).topic;
    if (a_topic > b_topic) {
        return 1;
    } else if (a_topic === b_topic) {
        return 0;
    }
    return -1;
}

export function complete_rerender() {
    if (!is_visible()) {
        return;
    }
    // Prepare header
    const rendered_body = render_recent_topics_body({
        filter_participated: filters.has("participated"),
        filter_unread: filters.has("unread"),
        filter_muted: filters.has("include_muted"),
        search_val: $("#recent_topics_search").val() || "",
    });
    $("#recent_topics_table").html(rendered_body);
    show_selected_filters();

    // Show topics list
    const container = $("#recent_topics_table table tbody");
    container.empty();
    const mapped_topic_values = Array.from(get().values()).map((value) => value);

    topics_widget = ListWidget.create(container, mapped_topic_values, {
        name: "recent_topics_table",
        parent_container: $("#recent_topics_table"),
        modifier(item) {
            return render_recent_topic_row(format_topic(item));
        },
        filter: {
            // We use update_filters_view & filters_should_hide_topic to do all the
            // filtering for us, which is called using click_handlers.
            predicate(topic_data) {
                return !filters_should_hide_topic(topic_data);
            },
        },
        sort_fields: {
            stream_sort,
            topic_sort,
        },
        html_selector: get_topic_row,
        simplebar_container: $("#recent_topics_table .table_fix_head"),
        callback_after_render: revive_current_focus,
    });
}

export function is_visible() {
    return $("#recent_topics_view").is(":visible");
}

export function show() {
    // Hide selected elements in the left sidebar.
    top_left_corner.narrow_to_recent_topics();
    stream_list.handle_narrow_deactivated();

    // Hide "middle-column" which has html for rendering
    // a messages narrow. We hide it and show recent topics.
    $("#message_feed_container").hide();
    $("#recent_topics_view").show();
    $("#message_view_header_underpadding").hide();
    $(".header").css("padding-bottom", "0px");

    // Save text in compose box if open.
    drafts.update_draft();
    // Close the compose box, this removes
    // any arbitrary bug for compose box in recent topics.
    // This is required since, Recent Topics is the only view
    // with no compose box.
    compose_actions.cancel();

    narrow_state.reset_current_filter();
    narrow.set_narrow_title("Recent topics");
    message_view_header.render_title_area();

    complete_rerender();
}

function filter_buttons() {
    return $("#recent_filters_group").children();
}

export function hide() {
    $("#message_feed_container").show();
    $("#recent_topics_view").hide();
    // On firefox (and flaky on other browsers), focus
    // remains on search box even after it is hidden. We
    // forcefully blur it so that focus returns to the visible
    // focused element.
    $("#recent_topics_search").blur();

    $("#message_view_header_underpadding").show();
    $(".header").css("padding-bottom", "10px");

    // This solves a bug with message_view_header
    // being broken sometimes when we narrow
    // to a filter and back to recent topics
    // before it completely re-rerenders.
    message_view_header.render_title_area();

    // Fixes misaligned message_view and hidden
    // floating_recipient_bar.
    panels.resize_app();

    // This makes sure user lands on the selected message
    // and not always at the top of the narrow.
    navigate.plan_scroll_to_selected();
}

export function change_focused_element(e, input_key) {
    // Called from hotkeys.js; like all logic in that module,
    // returning true will cause the caller to do
    // preventDefault/stopPropagation; false will let the browser
    // handle the key.
    const $elem = $(e.target);

    if (e.target.id === "recent_topics_search") {
        // Since the search box a text area, we want the browser to handle
        // Left/Right and selection within the widget; but if the user
        // arrows off the edges, we should move focus to the adjacent widgets..
        const textInput = $("#recent_topics_search").get(0);
        const start = textInput.selectionStart;
        const end = textInput.selectionEnd;
        const text_length = textInput.value.length;
        let is_selected = false;
        if (end - start > 0) {
            is_selected = true;
        }

        switch (input_key) {
            case "vim_left":
            case "vim_right":
            case "vim_down":
            case "vim_up":
                return false;
            case "shift_tab":
                current_focus_elem = filter_buttons().last();
                break;
            case "left_arrow":
                if (start !== 0 || is_selected) {
                    return false;
                }
                current_focus_elem = filter_buttons().last();
                break;
            case "tab":
                current_focus_elem = filter_buttons().first();
                break;
            case "right_arrow":
                if (end !== text_length || is_selected) {
                    return false;
                }
                current_focus_elem = filter_buttons().first();
                break;
            case "down_arrow":
                set_table_focus(row_focus, col_focus);
                return true;
            case "click":
                // Note: current_focus_elem can be different here, so we just
                // set current_focus_elem to the input box, we don't want .trigger("focus") on
                // it since it is already focused.
                // We only do this for search because we don't want the focus to
                // go away from the input box when `revive_current_focus` is called
                // on rerender when user is typing.
                current_focus_elem = $("#recent_topics_search");
                return true;
            case "escape":
                if (current_focus_elem === "table") {
                    return false;
                }
                set_table_focus(row_focus, col_focus);
                return true;
        }
    } else if ($elem.hasClass("btn-recent-filters")) {
        switch (input_key) {
            case "shift_tab":
            case "vim_left":
            case "left_arrow":
                if (filter_buttons().first()[0] === $elem[0]) {
                    current_focus_elem = $("#recent_topics_search");
                } else {
                    current_focus_elem = $elem.prev();
                }
                break;
            case "tab":
            case "vim_right":
            case "right_arrow":
                if (filter_buttons().last()[0] === $elem[0]) {
                    current_focus_elem = $("#recent_topics_search");
                } else {
                    current_focus_elem = $elem.next();
                }
                break;
            case "vim_down":
            case "down_arrow":
                set_table_focus(row_focus, col_focus);
                return true;
            case "escape":
                if (current_focus_elem === "table") {
                    return false;
                }
                set_table_focus(row_focus, col_focus);
                return true;
        }
    } else if (current_focus_elem === "table") {
        // For arrowing around the table of topics, we implement left/right
        // wraparound.  Going off the top or the bottom takes one
        // to the navigation at the top (see set_table_focus).
        switch (input_key) {
            case "escape":
                return false;
            case "open_recent_topics":
                set_default_focus();
                return true;
            case "shift_tab":
            case "vim_left":
            case "left_arrow":
                col_focus -= 1;
                if (col_focus < 0) {
                    col_focus = MAX_SELECTABLE_COLS - 1;
                }
                break;
            case "tab":
            case "vim_right":
            case "right_arrow":
                col_focus += 1;
                if (col_focus >= MAX_SELECTABLE_COLS) {
                    col_focus = 0;
                }
                break;
            case "vim_down":
            case "down_arrow":
                row_focus += 1;
                break;
            case "vim_up":
            case "up_arrow":
                row_focus -= 1;
        }
        set_table_focus(row_focus, col_focus);
        return true;
    }
    if (current_focus_elem && input_key !== "escape") {
        current_focus_elem.trigger("focus");
        return true;
    }

    return false;
}
