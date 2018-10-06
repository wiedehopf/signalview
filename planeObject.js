"use strict";

function PlaneObject(icao) {
	// Info about the plane
        this.icao      = icao;
        this.icaorange = findICAORange(icao);
        this.flight    = null;
        this.squawk    = null;
        this.selected  = false;
        this.category  = null;

	// Basic location information
        this.altitude       = null;
        this.alt_baro       = null;
        this.alt_geom       = null;

        this.speed          = null;
        this.gs             = null;
        this.ias            = null;
        this.tas            = null;

        this.track          = null;
        this.track_rate     = null;
        this.mag_heading    = null;
        this.true_heading   = null;
        this.mach           = null;
        this.roll           = null;
        this.nav_altitude   = null;
        this.nav_heading    = null;
        this.nav_modes      = null;
        this.nav_qnh        = null;
        this.rc				= null;
		
        this.nac_p			= null;
        this.nac_v			= null;
        this.nic_baro		= null;
        this.sil_type		= null;
        this.sil			= null;

        this.baro_rate      = null;
        this.geom_rate      = null;
        this.vert_rate      = null;

        this.version        = null;

        this.prev_position = null;
        this.position  = null;
        this.position_from_mlat = false
        this.sitedist  = null;

	// Data packet numbers
	this.messages  = null;
        this.rssi      = null;
	this.rssa      = null;
	this.rindex    = 0;

        // Track history as a series of line segments
        this.elastic_feature = null;
        this.track_linesegs = [];
        this.history_size = 0;

        // Time the previous position was received
        // (when the head of the elastic line segment was last updated)
        // used for detecting a stale position and switching to estimated track
        this.head_update = null;

        // Time when the tail of the elastic line segment was last updated
        // When extending the existing track,
        // tail_update is set to the timestamp of the appended point
        this.tail_update = null;

        // Track (direction) at the time we last appended to the track history
        this.tail_track = null;

	// When was this last updated (receiver timestamp)
        this.last_message_time = null;
        this.last_position_time = null;

        // When was this last updated (seconds before last update)
        this.seen = null;
        this.seen_pos = null;

        // Display info
        this.visible = true;
        this.marker = null;
        this.markerStyle = null;
        this.markerIcon = null;
        this.markerStaticStyle = null;
        this.markerStaticIcon = null;
        this.markerStyleKey = null;
        this.markerSvgKey = null;
        this.filter = {};

        // start from a computed registration, let the DB override it
        // if it has something else.
        this.registration = registration_from_hexid(this.icao);
        this.icaotype = null;
        this.typeDescription = null;
        this.wtc = null;

        // request metadata
        getAircraftData(this.icao).done(function(data) {
                if ("r" in data) {
                        this.registration = data.r;
                }

                if ("t" in data) {
                        this.icaotype = data.t;
                }

                if ("desc" in data) {
                        this.typeDescription = data.desc;
                }

                if ("wtc" in data) {
                        this.wtc = data.wtc;
                }

                if (this.selected) {
		        refreshSelected();
                }
        }.bind(this));
}

PlaneObject.prototype.isFiltered = function() {
    if (this.filter.minAltitude !== undefined && this.filter.maxAltitude !== undefined) {
        if (this.altitude === null || this.altitude === undefined) {
            return true;
        }
        var planeAltitude = this.altitude === "ground" ? 0 : convert_altitude(this.altitude, this.filter.altitudeUnits);
        return planeAltitude < this.filter.minAltitude || planeAltitude > this.filter.maxAltitude;
    }

    // filter out ground vehicles
    if (typeof this.filter.groundVehicles !== 'undefined' && this.filter.groundVehicles === 'filtered') {
        if (typeof this.category === 'string' && this.category.startsWith('C')) {
            return true;
        }
    }

    // filter out blocked MLAT flights
    if (typeof this.filter.blockedMLAT !== 'undefined' && this.filter.blockedMLAT === 'filtered') {
        if (typeof this.icao === 'string' && this.icao.startsWith('~')) {
            return true;
        }
    }

    return false;
}

// Appends data to the running track so we can get a visual tail on the plane
// Only useful for a long running browser session.
PlaneObject.prototype.updateTrack = function(receiver_timestamp, last_timestamp) {
        if (!this.position)
                return false;
        if (this.prev_position && this.position[0] == this.prev_position[0] && this.position[1] == this.prev_position[1])
                return false;

        var projHere = ol.proj.fromLonLat(this.position);
        var projPrev;
        if (this.prev_position === null) {
                projPrev = projHere;
        } else {
                projPrev = ol.proj.fromLonLat(this.prev_position);
        }

        this.prev_position = this.position;

        if (this.track_linesegs.length == 0) {
                // Brand new track
                //console.log(this.icao + " new track");
                var newseg = { fixed: new ol.geom.LineString([projHere]),
                               feature: null,
                               estimated: false,
                               ground: (this.altitude === "ground"),
                               altitude: this.rssi
                             };
                this.track_linesegs.push(newseg);
                this.head_update = this.last_position_time;
                this.tail_update = this.last_position_time;
                this.history_size ++;
                return;
        }

        var lastseg = this.track_linesegs[this.track_linesegs.length - 1];

        // Determine if track data are intermittent/stale
        // Time difference between two position updates should not be much
        // greater than the difference between data inputs
        var time_difference = (this.last_position_time - this.head_update) - (receiver_timestamp - last_timestamp);

        // MLAT data are given some more leeway
        var stale_timeout = (this.position_from_mlat ? 30 : 10);
        var est_track = (time_difference > stale_timeout);

        // Also check if the position was already stale when it was exported by dump1090
        // Makes stale check more accurate for example for 30s spaced history points

        est_track = est_track || ((receiver_timestamp - this.last_position_time) > stale_timeout);

        // head_update is not used in the rest of the function, set it for the next call of this function
        this.head_update = this.last_position_time;

        var ground_track = (this.altitude === "ground");
        
        if (est_track) {

                if (!lastseg.estimated) {
                        // >5s gap in data, create a new estimated segment
                        //console.log(this.icao + " switching to estimated");
                        if (lastseg.fixed.getLastCoordinate()[0] != projPrev[0]) {
                                lastseg.fixed.appendCoordinate(projPrev);
                                this.history_size ++;
                        }
                        this.track_linesegs.push({ fixed: new ol.geom.LineString([projPrev, projHere]),
                                                   feature: null,
                                                   altitude: 0,
                                                   estimated: true });
                        this.tail_update = this.last_position_time;
                        this.tail_track = this.track;
                        this.history_size += 2;
                } else {
                        // Keep appending to the existing dashed line; keep every point
                        lastseg.fixed.appendCoordinate(projHere);
                        this.tail_update = this.last_position_time;
                        this.tail_track = this.track;
                        this.history_size++;
                }

                return true;
        }
        
        if (lastseg.estimated) {
                // We are back to good data (we got two points close in time), switch back to
                // solid lines.
                lastseg = { fixed: new ol.geom.LineString([projPrev]),
                            feature: null,
                            estimated: false,
                            ground: (this.altitude === "ground"),
                            altitude: this.rssi };
                this.track_linesegs.push(lastseg);
                this.history_size ++;
                // continue
                // tail_update and tail_track don't need to be updated here
                // as the previous point is already part of the estimated track
                // and both were updated when the previous point was appended
        }
        
        var since_update = this.last_position_time - this.tail_update;
        if ( (lastseg.ground && this.altitude !== "ground") ||
             (!lastseg.ground && this.altitude === "ground") || Math.abs(this.rssi - lastseg.altitude) > 1 || this.rssi >-3.5) {
                //console.log(this.icao + " ground state changed");
                // Create a new segment as the ground state or the altitude changed.
                // The new state is only drawn after the state has changed
                // and we get a new position.

                lastseg.fixed.appendCoordinate(projHere);
                this.track_linesegs.push({ fixed: new ol.geom.LineString([projHere]),
                                           feature: null,
                                           estimated: false,
                                           altitude: this.rssi,
                                           ground: (this.altitude === "ground") });
                this.tail_update = this.last_position_time;
                this.tail_track = this.track;
                this.history_size += 2;
                //if (this.selected)
		//	console.log((this.altitude-lastseg.altitude) + "  " + since_update.toPrecision(3) + "  " +this.history_size);
                return true;
        }
        
        // Add current position to the existing track.
        // We only retain some points depending on time elapsed and track change
        var track_change = (this.tail_track && this.track) ? Math.abs(this.tail_track - this.track) : -1;

        if ( since_update > 32 ||
             (track_change > 1 && since_update > 2) ||
             (track_change > 0.25 && since_update > 4) ||
             (this.position_from_mlat && since_update > 8) ||
             (track_change == -1 && since_update > 4) )
        {
                // enough time has elapsed; retain the last point and add a new one
                //if (this.selected) console.log(track_change.toPrecision(2) + "  " + since_update.toPrecision(3) + "  " +this.history_size);
                // Starting a curve let's append the previous point unless part of the track.
                // Checking one part of the coordinate should suffice here.
                if (track_change > 1 && since_update > 2 && lastseg.fixed.getLastCoordinate()[0] != projPrev[0]) {
                        lastseg.fixed.appendCoordinate(projPrev);
			this.history_size ++;
                }
                lastseg.fixed.appendCoordinate(projHere);
                this.tail_update = this.last_position_time;
                this.tail_track = this.track;
                this.history_size ++;
        }

        return true;
};

// This is to remove the line from the screen if we deselect the plane
PlaneObject.prototype.clearLines = function() {
        for (var i = this.track_linesegs.length - 1; i >= 0 ; --i) {
                var seg = this.track_linesegs[i];
                if (seg.feature !== null) {
                        PlaneTrailFeatures.remove(seg.feature);
                        seg.feature = null;
                }
        }

        if (this.elastic_feature !== null) {
                PlaneTrailFeatures.remove(this.elastic_feature);
                this.elastic_feature = null;
        }
};

PlaneObject.prototype.getDataSource = function() {
    // MLAT
    if (this.position_from_mlat) {
        return 'mlat';
    }

    // Not MLAT, but position reported - ADSB or variants
    if (this.position !== null) {
        return this.addrtype;
    }

    // Otherwise Mode S
    return 'mode_s';

    // TODO: add support for Mode A/C
};

PlaneObject.prototype.getMarkerColor = function() {
        // Emergency squawks override everything else
        if (this.squawk in SpecialSquawks)
                return SpecialSquawks[this.squawk].markerColor;

        var h, s, l;

        var colorArr = this.getAltitudeColor();

        h = colorArr[0];
        s = colorArr[1];
        l = colorArr[2];

        // If we have not seen a recent position update, change color
        if (this.seen_pos > 15) {
                h += ColorByAlt.stale.h;
                s += ColorByAlt.stale.s;
                l += ColorByAlt.stale.l;
        }

        // If this marker is selected, change color
        if (this.selected && !SelectedAllPlanes){
                h += ColorByAlt.selected.h;
                s += ColorByAlt.selected.s;
                l += ColorByAlt.selected.l;
        }

        // If this marker is a mlat position, change color
        if (this.position_from_mlat) {
                h += ColorByAlt.mlat.h;
                s += ColorByAlt.mlat.s;
                l += ColorByAlt.mlat.l;
        }

        if (h < 0) {
                h = (h % 360) + 360;
        } else if (h >= 360) {
                h = h % 360;
        }

        if (s < 5) s = 5;
        else if (s > 95) s = 95;

        if (l < 5) l = 5;
        else if (l > 95) l = 95;

        return 'hsl(' + (h/5).toFixed(0)*5 + ',' + (s/5).toFixed(0)*5 + '%,' + (l/5).toFixed(0)*5 + '%)'
}

PlaneObject.prototype.getAltitudeColor = function(altitude) {
        var h, s, l;

        if (typeof altitude === 'undefined') {
            altitude = this.rssi;
        }

        if (altitude === null) {
                h = ColorByAlt.unknown.h;
                s = ColorByAlt.unknown.s;
                l = ColorByAlt.unknown.l;
        } else if (altitude === "ground") {
                h = ColorByAlt.ground.h;
                s = ColorByAlt.ground.s;
                l = ColorByAlt.ground.l;
        } else {
                s = ColorByAlt.air.s;
                l = ColorByAlt.air.l;

                // find the pair of points the current altitude lies between,
                // and interpolate the hue between those points
                var hpoints = ColorByAlt.air.h;
                h = hpoints[0].val;
                for (var i = hpoints.length-1; i >= 0; --i) {
                        if (altitude > hpoints[i].alt) {
                                if (i == hpoints.length-1) {
                                        h = hpoints[i].val;
                                } else {
                                        h = hpoints[i].val + (hpoints[i+1].val - hpoints[i].val) * (altitude - hpoints[i].alt) / (hpoints[i+1].alt - hpoints[i].alt)
                                }
                                break;
                        }
                }
        }

         if (h < 0) {
                h = (h % 360) + 360;
        } else if (h >= 360) {
                h = h % 360;
        }

        if (s < 5) s = 5;
        else if (s > 95) s = 95;

        if (l < 5) l = 5;
        else if (l > 95) l = 95;

        return [h, s, l];
}

PlaneObject.prototype.updateIcon = function() {
        var scaleFactor = Math.max(0.2, Math.min(1.2, 0.15 * Math.pow(1.25, ZoomLvl))).toFixed(1);

        var col = this.getMarkerColor();
        var opacity = 1.0;
        var outline = (this.position_from_mlat ? OutlineMlatColor : OutlineADSBColor);
        var add_stroke = (this.selected && !SelectedAllPlanes) ? ' stroke="black" stroke-width="1px"' : '';
        var baseMarker = getBaseMarker(this.category, this.icaotype, this.typeDescription, this.wtc);
        var rotation = (this.track === null ? 0 : this.track);
        //var transparentBorderWidth = (32 / baseMarker.scale / scaleFactor).toFixed(1);

        var svgKey = col + '!' + outline + '!' + baseMarker.svg + '!' + add_stroke + "!" + scaleFactor;
        var styleKey = opacity + '!' + rotation;

        if (this.markerStyle === null || this.markerIcon === null || this.markerSvgKey != svgKey) {
                //console.log(this.icao + " new icon and style " + this.markerSvgKey + " -> " + svgKey);

                var icon = new ol.style.Icon({
                        anchor: [0.5, 0.5],
                        anchorXUnits: 'fraction',
                        anchorYUnits: 'fraction',
                        scale: 1.2 * scaleFactor,
                        imgSize: baseMarker.size,
                        src: svgPathToURI(baseMarker.svg, outline, col, add_stroke),
                        rotation: (baseMarker.noRotate ? 0 : rotation * Math.PI / 180.0),
                        opacity: opacity,
                        rotateWithView: (baseMarker.noRotate ? false : true)
                });

                this.markerIcon = icon;
                this.markerStyle = new ol.style.Style({
                        image: this.markerIcon
                });
                this.markerStaticIcon = null;
                this.markerStaticStyle = new ol.style.Style({});

                this.markerStyleKey = styleKey;
                this.markerSvgKey = svgKey;

                if (this.marker !== null) {
                        this.marker.setStyle(this.markerStyle);
                        this.markerStatic.setStyle(this.markerStaticStyle);
                }
        }

        if (this.markerStyleKey != styleKey) {
                //console.log(this.icao + " new rotation");
                this.markerIcon.setRotation(rotation * Math.PI / 180.0);
                this.markerIcon.setOpacity(opacity);
                if (this.staticIcon) {
                        this.staticIcon.setOpacity(opacity);
                }
                this.markerStyleKey = styleKey;
        }

        return true;
};

// Update our data
PlaneObject.prototype.updateData = function(receiver_timestamp, data) {
	// Update all of our data
	this.messages	= data.messages;
	if (!this.rssa)
		this.rssa = [data.rssi,data.rssi,data.rssi,data.rssi];
	this.rssa[this.rindex++%4] = data.rssi;
        this.rssi       = (((this.rssa[0] + this.rssa[1] + this.rssa[2] + this.rssa[3])*10)>>2)/10;
	this.last_message_time = receiver_timestamp - data.seen;

        // simple fields

        var fields = ["alt_baro", "alt_geom", "gs", "ias", "tas", "track",
                      "track_rate", "mag_heading",  "mach",
					  "roll", "nav_altitude", "nav_heading", "nav_modes",
					  "nac_p", "nac_v", "nic_baro", "sil_type", "sil",
                      "nav_qnh", "baro_rate", "geom_rate", "rc",
                      "squawk", "category", "version"];

        for (var i = 0; i < fields.length; ++i) {
                if (fields[i] in data) {
                        this[fields[i]] = data[fields[i]];
                } else {
                        this[fields[i]] = null;
                }
        }

        // fields with more complex behaviour
	if ("true_heading" in data)
		this.true_heading = data.true_heading;

        if ('type' in data)
                this.addrtype	= data.type;
        else
                this.addrtype   = 'adsb_icao';

        // don't expire callsigns
        if ('flight' in data)
                this.flight	= data.flight;

        if ('lat' in data && 'lon' in data) {
                this.position   = [data.lon, data.lat];
                this.last_position_time = receiver_timestamp - data.seen_pos;

                if (SitePosition !== null) {
                        var WGS84 = new ol.Sphere(6378137);
                        this.sitedist = WGS84.haversineDistance(SitePosition, this.position);
                }

                this.position_from_mlat = false;
                if (typeof data.mlat !== "undefined") {
                        for (var i = 0; i < data.mlat.length; ++i) {
                                if (data.mlat[i] === "lat" || data.mlat[i] == "lon") {
                                        this.position_from_mlat = true;
                                        break;
                                }
                        }
                }
        }
//	if (this.sitedist)
//		this.rssi = 5+1.2*(this.rssi + 20*Math.log10(this.sitedist/100000));

        // Pick an altitude
        if ('alt_baro' in data) {
                this.altitude = data.alt_baro;
        } else if ('alt_geom' in data) {
                this.altitude = data.alt_geom;
        } else {
                this.altitude = null;
        }

        // Pick vertical rate from either baro or geom rate
        // geometric rate is generally more reliable (smoothed etc)
        if ('geom_rate' in data) {
                this.vert_rate = data.geom_rate;
        } else if ('baro_rate' in data) {
                this.vert_rate = data.baro_rate;
        } else {
                this.vert_rate = null;
        }

        // Pick a speed
        if ('gs' in data) {
                this.speed = data.gs;
        } else if ('tas' in data) {
                this.speed = data.tas;
        } else if ('ias' in data) {
                this.speed = data.ias;
        } else {
                this.speed = null;
        }
};

PlaneObject.prototype.updateTick = function(receiver_timestamp, last_timestamp) {
        // recompute seen and seen_pos
        this.seen = receiver_timestamp - this.last_message_time;
        this.seen_pos = (this.last_position_time === null ? null : receiver_timestamp - this.last_position_time);
        
	// If no packet in over 58 seconds, clear the plane.
	if (this.seen > 58) {
                if (this.visible) {
                        //console.log("hiding " + this.icao);
                        this.clearMarker();
                        this.visible = false;
			if (SelectedPlane == this.icao)
                                selectPlaneByHex(null,false);
                }
	} else {
                if (this.position !== null && (this.selected || this.seen_pos < 60)) {
			this.visible = true;
			if (this.updateTrack(receiver_timestamp, last_timestamp)) {
                                this.updateLines();
                                this.updateMarker(true);
                        } else { 
                                this.updateMarker(false); // didn't move
                        }
                } else {
			this.clearMarker();
			this.visible = false;
		}
	}
};

PlaneObject.prototype.clearMarker = function() {
	if (this.marker) {
                PlaneIconFeatures.remove(this.marker);
                PlaneIconFeatures.remove(this.markerStatic);
                /* FIXME google.maps.event.clearListeners(this.marker, 'click'); */
                this.marker = this.markerStatic = null;
	}
};

// Update our marker on the map
PlaneObject.prototype.updateMarker = function(moved) {
        if (!this.visible || this.position == null || this.isFiltered()) {
                this.clearMarker();
                return;
        }
        
        this.updateIcon();
        if (this.marker) {
                if (moved) {
                        this.marker.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(this.position)));
                        this.markerStatic.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(this.position)));
                }
        } else {
                this.marker = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat(this.position)));
                this.marker.hex = this.icao;
                this.marker.setStyle(this.markerStyle);
                PlaneIconFeatures.push(this.marker);

                this.markerStatic = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat(this.position)));
                this.markerStatic.hex = this.icao;
                this.markerStatic.setStyle(this.markerStaticStyle);
                PlaneIconFeatures.push(this.markerStatic);
	}
};


// return the styling of the lines based on altitude
PlaneObject.prototype.altitudeLines = function(altitude) {
    var colorArr = this.getAltitudeColor(altitude);
    return new ol.style.Style({
        stroke: new ol.style.Stroke({
            color: 'hsl(' + (colorArr[0]/5).toFixed(0)*5 + ',' + (colorArr[1]/5).toFixed(0)*5 + '%,' + (colorArr[2]/5).toFixed(0)*5 + '%)',
            width: 2
        })
    })
}

// Update our planes tail line,
PlaneObject.prototype.updateLines = function() {
        if (!this.selected)
                return;

        if (this.track_linesegs.length == 0)
                return;

        var estimateStyle = new ol.style.Style({
                stroke: new ol.style.Stroke({
                        color: '#a08080',
                        width: 1.5,
                        lineDash: [3, 3]
                })
        });

        var airStyle = new ol.style.Style({
                stroke: new ol.style.Stroke({
                        color: '#000000',
                        width: 2
                })
        });

        var groundStyle = new ol.style.Style({
                stroke: new ol.style.Stroke({
                        color: '#408040',
                        width: 2
                })
        });

        // find the old elastic band so we can replace it in place
        // (which should be faster than remove-and-add when PlaneTrailFeatures is large)
        var oldElastic = -1;
        if (this.elastic_feature !== null) {
                oldElastic = PlaneTrailFeatures.getArray().indexOf(this.elastic_feature);
        }

        // create the new elastic band feature
        var lastseg = this.track_linesegs[this.track_linesegs.length - 1];
        var lastfixed = lastseg.fixed.getCoordinateAt(1.0);
        var geom = new ol.geom.LineString([lastfixed, ol.proj.fromLonLat(this.position)]);
        this.elastic_feature = new ol.Feature(geom);
        this.elastic_feature.setStyle(this.altitudeLines(lastseg.altitude));

        if (oldElastic < 0) {
                PlaneTrailFeatures.push(this.elastic_feature);
        } else {
                PlaneTrailFeatures.setAt(oldElastic, this.elastic_feature);
        }

        // create any missing fixed line features
        for (var i = 0; i < this.track_linesegs.length; ++i) {
                var seg = this.track_linesegs[i];
                if (seg.feature === null) {
                        seg.feature = new ol.Feature(seg.fixed);
                        if (seg.estimated) {
                                seg.feature.setStyle(estimateStyle);
                        } else {
                                seg.feature.setStyle(this.altitudeLines(seg.altitude));
                        }

                        PlaneTrailFeatures.push(seg.feature);
                }
        }
};

PlaneObject.prototype.destroy = function() {
        this.clearLines();
        this.clearMarker();
};
