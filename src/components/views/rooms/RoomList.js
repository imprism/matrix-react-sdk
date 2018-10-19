/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017, 2018 Vector Creations Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';
import SettingsStore from "../../../settings/SettingsStore";

const React = require("react");
const ReactDOM = require("react-dom");
import PropTypes from 'prop-types';
import { _t } from '../../../languageHandler';
const MatrixClientPeg = require("../../../MatrixClientPeg");
const CallHandler = require('../../../CallHandler');
const dis = require("../../../dispatcher");
const sdk = require('../../../index');
const rate_limited_func = require('../../../ratelimitedfunc');
import * as Rooms from '../../../Rooms';
import DMRoomMap from '../../../utils/DMRoomMap';
const Receipt = require('../../../utils/Receipt');
import TagOrderStore from '../../../stores/TagOrderStore';
import RoomListStore from '../../../stores/RoomListStore';
import GroupStore from '../../../stores/GroupStore';

import ResizeHandle from '../elements/ResizeHandle';
import {Resizer, FixedDistributor, FlexSizer} from '../../../resizer'
const HIDE_CONFERENCE_CHANS = true;
const STANDARD_TAGS_REGEX = /^(m\.(favourite|lowpriority|server_notice)|im\.vector\.fake\.(invite|recent|direct|archived))$/;

function labelForTagName(tagName) {
    if (tagName.startsWith('u.')) return tagName.slice(2);
    return tagName;
}

function phraseForSection(section) {
    switch (section) {
        case 'm.favourite':
            return _t('Drop here to favourite');
        case 'im.vector.fake.direct':
            return _t('Drop here to tag direct chat');
        case 'im.vector.fake.recent':
            return _t('Drop here to restore');
        case 'm.lowpriority':
            return _t('Drop here to demote');
        default:
            return _t('Drop here to tag %(section)s', {section: section});
    }
}

module.exports = React.createClass({
    displayName: 'RoomList',

    propTypes: {
        ConferenceHandler: PropTypes.any,
        collapsed: PropTypes.bool.isRequired,
        searchFilter: PropTypes.string,
    },

    getInitialState: function() {
        return {
            isLoadingLeftRooms: false,
            totalRoomCount: null,
            lists: {},
            incomingCall: null,
            selectedTags: [],
        };
    },

    componentWillMount: function() {
        this.mounted = false;

        const cli = MatrixClientPeg.get();

        cli.on("Room", this.onRoom);
        cli.on("deleteRoom", this.onDeleteRoom);
        cli.on("Room.receipt", this.onRoomReceipt);
        cli.on("RoomMember.name", this.onRoomMemberName);
        cli.on("Event.decrypted", this.onEventDecrypted);
        cli.on("accountData", this.onAccountData);
        cli.on("Group.myMembership", this._onGroupMyMembership);

        const dmRoomMap = DMRoomMap.shared();
        // A map between tags which are group IDs and the room IDs of rooms that should be kept
        // in the room list when filtering by that tag.
        this._visibleRoomsForGroup = {
            // $groupId: [$roomId1, $roomId2, ...],
        };
        // All rooms that should be kept in the room list when filtering.
        // By default, show all rooms.
        this._visibleRooms = MatrixClientPeg.get().getVisibleRooms();

        // Listen to updates to group data. RoomList cares about members and rooms in order
        // to filter the room list when group tags are selected.
        this._groupStoreToken = GroupStore.registerListener(null, () => {
            (TagOrderStore.getOrderedTags() || []).forEach((tag) => {
                if (tag[0] !== '+') {
                    return;
                }
                // This group's rooms or members may have updated, update rooms for its tag
                this.updateVisibleRoomsForTag(dmRoomMap, tag);
                this.updateVisibleRooms();
            });
        });

        this._tagStoreToken = TagOrderStore.addListener(() => {
            // Filters themselves have changed
            this.updateVisibleRooms();
        });

        this._roomListStoreToken = RoomListStore.addListener(() => {
            this._delayedRefreshRoomList();
        });

        this.refreshRoomList();

        // order of the sublists
        //this.listOrder = [];

        // loop count to stop a stack overflow if the user keeps waggling the
        // mouse for >30s in a row, or if running under mocha
        this._delayedRefreshRoomListLoopCount = 0;
    },

    componentDidMount: function() {
        this.dispatcherRef = dis.register(this.onAction);
        this.resizer = new Resizer(this.resizeContainer, FixedDistributor, null, FlexSizer);
        this.resizer.setClassNames({
            handle: "mx_ResizeHandle",
            vertical: "mx_ResizeHandle_vertical",
            reverse: "mx_ResizeHandle_reverse"
        });
        this.resizer.attach();
        this.mounted = true;
    },

    componentDidUpdate: function() {
        this._repositionIncomingCallBox(undefined, false);
    },

    onAction: function(payload) {
        switch (payload.action) {
            case 'view_tooltip':
                this.tooltip = payload.tooltip;
                break;
            case 'call_state':
                var call = CallHandler.getCall(payload.room_id);
                if (call && call.call_state === 'ringing') {
                    this.setState({
                        incomingCall: call,
                    });
                    this._repositionIncomingCallBox(undefined, true);
                } else {
                    this.setState({
                        incomingCall: null,
                    });
                }
                break;
        }
    },

    componentWillUnmount: function() {
        this.mounted = false;

        dis.unregister(this.dispatcherRef);
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener("Room", this.onRoom);
            MatrixClientPeg.get().removeListener("deleteRoom", this.onDeleteRoom);
            MatrixClientPeg.get().removeListener("Room.receipt", this.onRoomReceipt);
            MatrixClientPeg.get().removeListener("RoomMember.name", this.onRoomMemberName);
            MatrixClientPeg.get().removeListener("Event.decrypted", this.onEventDecrypted);
            MatrixClientPeg.get().removeListener("accountData", this.onAccountData);
            MatrixClientPeg.get().removeListener("Group.myMembership", this._onGroupMyMembership);
        }

        if (this._tagStoreToken) {
            this._tagStoreToken.remove();
        }

        if (this._roomListStoreToken) {
            this._roomListStoreToken.remove();
        }

        // NB: GroupStore is not a Flux.Store
        if (this._groupStoreToken) {
            this._groupStoreToken.unregister();
        }

        // cancel any pending calls to the rate_limited_funcs
        this._delayedRefreshRoomList.cancelPendingCall();
    },

    onRoom: function(room) {
        this.updateVisibleRooms();
    },

    onDeleteRoom: function(roomId) {
        this.updateVisibleRooms();
    },

    onArchivedHeaderClick: function(isHidden, scrollToPosition) {
        if (!isHidden) {
            const self = this;
            this.setState({ isLoadingLeftRooms: true });
            // we don't care about the response since it comes down via "Room"
            // events.
            MatrixClientPeg.get().syncLeftRooms().catch(function(err) {
                console.error("Failed to sync left rooms: %s", err);
                console.error(err);
            }).finally(function() {
                self.setState({ isLoadingLeftRooms: false });
            });
        }
    },

    onRoomReceipt: function(receiptEvent, room) {
        // because if we read a notification, it will affect notification count
        // only bother updating if there's a receipt from us
        if (Receipt.findReadReceiptFromUserId(receiptEvent, MatrixClientPeg.get().credentials.userId)) {
            this._delayedRefreshRoomList();
        }
    },

    onRoomMemberName: function(ev, member) {
        this._delayedRefreshRoomList();
    },

    onEventDecrypted: function(ev) {
        // An event being decrypted may mean we need to re-order the room list
        this._delayedRefreshRoomList();
    },

    onAccountData: function(ev) {
        if (ev.getType() == 'm.direct') {
            this._delayedRefreshRoomList();
        }
    },

    _onGroupMyMembership: function(group) {
        this.forceUpdate();
    },

    _delayedRefreshRoomList: new rate_limited_func(function() {
        this.refreshRoomList();
    }, 500),

    // Update which rooms and users should appear in RoomList for a given group tag
    updateVisibleRoomsForTag: function(dmRoomMap, tag) {
        if (!this.mounted) return;
        // For now, only handle group tags
        if (tag[0] !== '+') return;

        this._visibleRoomsForGroup[tag] = [];
        GroupStore.getGroupRooms(tag).forEach((room) => this._visibleRoomsForGroup[tag].push(room.roomId));
        GroupStore.getGroupMembers(tag).forEach((member) => {
            if (member.userId === MatrixClientPeg.get().credentials.userId) return;
            dmRoomMap.getDMRoomsForUserId(member.userId).forEach(
                (roomId) => this._visibleRoomsForGroup[tag].push(roomId),
            );
        });
        // TODO: Check if room has been tagged to the group by the user
    },

    // Update which rooms and users should appear according to which tags are selected
    updateVisibleRooms: function() {
        const selectedTags = TagOrderStore.getSelectedTags();
        const visibleGroupRooms = [];
        selectedTags.forEach((tag) => {
            (this._visibleRoomsForGroup[tag] || []).forEach(
                (roomId) => visibleGroupRooms.push(roomId),
            );
        });

        // If there are any tags selected, constrain the rooms listed to the
        // visible rooms as determined by visibleGroupRooms. Here, we
        // de-duplicate and filter out rooms that the client doesn't know
        // about (hence the Set and the null-guard on `room`).
        if (selectedTags.length > 0) {
            const roomSet = new Set();
            visibleGroupRooms.forEach((roomId) => {
                const room = MatrixClientPeg.get().getRoom(roomId);
                if (room) {
                    roomSet.add(room);
                }
            });
            this._visibleRooms = Array.from(roomSet);
        } else {
            // Show all rooms
            this._visibleRooms = MatrixClientPeg.get().getVisibleRooms();
        }
        this._delayedRefreshRoomList();
    },

    refreshRoomList: function() {
        // TODO: ideally we'd calculate this once at start, and then maintain
        // any changes to it incrementally, updating the appropriate sublists
        // as needed.
        // Alternatively we'd do something magical with Immutable.js or similar.
        const lists = this.getRoomLists();
        let totalRooms = 0;
        for (const l of Object.values(lists)) {
            totalRooms += l.length;
        }
        this.setState({
            lists,
            totalRoomCount: totalRooms,
            // Do this here so as to not render every time the selected tags
            // themselves change.
            selectedTags: TagOrderStore.getSelectedTags(),
        });

        // this._lastRefreshRoomListTs = Date.now();
    },

    getRoomLists: function() {
        const lists = RoomListStore.getRoomLists();

        const filteredLists = {};

        const isRoomVisible = {
            // $roomId: true,
        };

        this._visibleRooms.forEach((r) => {
            isRoomVisible[r.roomId] = true;
        });

        Object.keys(lists).forEach((tagName) => {
            const filteredRooms = lists[tagName].filter((taggedRoom) => {
                // Somewhat impossible, but guard against it anyway
                if (!taggedRoom) {
                    return;
                }
                const myUserId = MatrixClientPeg.get().getUserId();
                if (HIDE_CONFERENCE_CHANS && Rooms.isConfCallRoom(taggedRoom, myUserId, this.props.ConferenceHandler)) {
                    return;
                }

                return Boolean(isRoomVisible[taggedRoom.roomId]);
            });

            if (filteredRooms.length > 0 || tagName.match(STANDARD_TAGS_REGEX)) {
                filteredLists[tagName] = filteredRooms;
            }
        });

        return filteredLists;
    },

    _getScrollNode: function() {
        if (!this.mounted) return null;
        const panel = ReactDOM.findDOMNode(this);
        if (!panel) return null;

        if (panel.classList.contains('gm-prevented')) {
            return panel;
        } else {
            return panel.children[2]; // XXX: Fragile!
        }
    },

    _whenScrolling: function(e) {
        this._hideTooltip(e);
        this._repositionIncomingCallBox(e, false);
    },

    _hideTooltip: function(e) {
        // Hide tooltip when scrolling, as we'll no longer be over the one we were on
        if (this.tooltip && this.tooltip.style.display !== "none") {
            this.tooltip.style.display = "none";
        }
    },

    _repositionIncomingCallBox: function(e, firstTime) {
        const incomingCallBox = document.getElementById("incomingCallBox");
        if (incomingCallBox && incomingCallBox.parentElement) {
            const scrollArea = this._getScrollNode();
            if (!scrollArea) return;
            // Use the offset of the top of the scroll area from the window
            // as this is used to calculate the CSS fixed top position for the stickies
            const scrollAreaOffset = scrollArea.getBoundingClientRect().top + window.pageYOffset;
            // Use the offset of the top of the component from the window
            // as this is used to calculate the CSS fixed top position for the stickies
            const scrollAreaHeight = ReactDOM.findDOMNode(this).getBoundingClientRect().height;

            let top = (incomingCallBox.parentElement.getBoundingClientRect().top + window.pageYOffset);
            // Make sure we don't go too far up, if the headers aren't sticky
            top = (top < scrollAreaOffset) ? scrollAreaOffset : top;
            // make sure we don't go too far down, if the headers aren't sticky
            const bottomMargin = scrollAreaOffset + (scrollAreaHeight - 45);
            top = (top > bottomMargin) ? bottomMargin : top;

            incomingCallBox.style.top = top + "px";
            incomingCallBox.style.left = scrollArea.offsetLeft + scrollArea.offsetWidth + 12 + "px";
        }
    },

    _getHeaderItems: function(section) {
        const StartChatButton = sdk.getComponent('elements.StartChatButton');
        const RoomDirectoryButton = sdk.getComponent('elements.RoomDirectoryButton');
        const CreateRoomButton = sdk.getComponent('elements.CreateRoomButton');
        switch (section) {
            case 'im.vector.fake.direct':
                return <span className="mx_RoomList_headerButtons">
                    <StartChatButton size="16" />
                </span>;
            case 'im.vector.fake.recent':
                return <span className="mx_RoomList_headerButtons">
                    <RoomDirectoryButton size="16" />
                    <CreateRoomButton size="16" />
                </span>;
        }
    },

    _makeGroupInviteTiles(filter) {
        const ret = [];
        const lcFilter = filter && filter.toLowerCase();

        const GroupInviteTile = sdk.getComponent('groups.GroupInviteTile');
        for (const group of MatrixClientPeg.get().getGroups()) {
            const {groupId, name, myMembership} = group;
            // filter to only groups in invite state and group_id starts with filter or group name includes it
            if (myMembership !== 'invite') continue;
            if (lcFilter && !groupId.toLowerCase().startsWith(lcFilter) &&
                !(name && name.toLowerCase().includes(lcFilter))) continue;
            ret.push(<GroupInviteTile key={groupId} group={group} collapsed={this.props.collapsed} />);
        }

        return ret;
    },

    render: function() {
        const RoomSubList = sdk.getComponent('structures.RoomSubList');


        const self = this;

        function mapProps(subListsProps) {
            const defaultProps = {
                collapsed: self.props.collapsed,
                searchFilter: self.props.searchFilter,
                incomingCall: self.state.incomingCall,
            };
            return subListsProps.reduce((components, props, i) => {
                props = Object.assign({}, defaultProps, props);
                const isLast = i === subListsProps.length - 1;
                const len = props.list.length + (props.extraTiles ? props.extraTiles.length : 0);
                // empty and no add button? dont render
                if (!len && !props.onAddRoom) {
                    return components;
                }
                const {key, label, ... otherProps} = props;
                const chosenKey = key || label;

                let subList = <RoomSubList key={chosenKey} label={label} {...otherProps} />;
                if (!isLast) {
                    return components.concat(
                        subList,
                        <ResizeHandle key={chosenKey+"-resizer"} vertical={true} />
                    );
                } else {
                    return components.concat(subList);
                }
            }, []);
        }

        let subLists = [
            {
                list: [],
                extraTiles: this._makeGroupInviteTiles(self.props.searchFilter),
                label: _t('Community Invites'),
                order: "recent",
                isInvite: true,
            },
            {
                list: self.state.lists['im.vector.fake.invite'],
                label: _t('Invites'),
                order: "recent",
                isInvite: true,
            },
            {
                list: self.state.lists['m.favourite'],
                label: _t('Favourites'),
                tagName: "m.favourite",
                order: "manual",
            },
            {
                list: self.state.lists['im.vector.fake.direct'],
                label: _t('People'),
                tagName: "im.vector.fake.direct",
                headerItems: this._getHeaderItems('im.vector.fake.direct'),
                order: "recent",
                onAddRoom: () => {dis.dispatch({action: 'view_create_chat'})},
            },
            {
                list: self.state.lists['im.vector.fake.recent'],
                label: _t('Rooms'),
                headerItems: this._getHeaderItems('im.vector.fake.recent'),
                order: "recent",
                onAddRoom: () => {dis.dispatch({action: 'view_create_room'})},
            },
        ];
        const tagSubLists = Object.keys(self.state.lists)
            .filter((tagName) => {
                return !tagName.match(STANDARD_TAGS_REGEX);
            }).map((tagName) => {
                return {
                    list: self.state.lists[tagName],
                    key: tagName,
                    label: labelForTagName(tagName),
                    tagName: tagName,
                    order: "manual",
                };
            });
        subLists = subLists.concat(tagSubLists);
        subLists = subLists.concat([
            {
                list: self.state.lists['m.lowpriority'],
                label: _t('Low priority'),
                tagName: "m.lowpriority",
                order: "recent",
            },
            {
                list: self.state.lists['im.vector.fake.archived'],
                label: _t('Historical'),
                order: "recent",
                startAsHidden: true,
                showSpinner: self.state.isLoadingLeftRooms,
                onHeaderClick: self.onArchivedHeaderClick,
            },
            {
                list: self.state.lists['m.server_notice'],
                label: _t('System Alerts'),
                tagName: "m.lowpriority",
                order: "recent",
            },
        ]);

        const subListComponents = mapProps(subLists);

        return (
            <div ref={(d) => this.resizeContainer = d} className="mx_RoomList">
                { subListComponents }
            </div>
        );
    },
});
