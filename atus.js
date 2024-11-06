var addToUpdateSetUtils = Class.create();
addToUpdateSetUtils.prototype = {
    initialize: function() {
        this.updateSetBatchingURL = "https://docs.servicenow.com/bundle/vancouver-application-development/page/build/system-update-sets/hier-update-sets/concept/us-hier-overview.html";

        // Gather user preferences rom system properties
        this.includeUsersWithGroups = gs.getProperty("addToUpdateSetUtils.group.add_users", "true") == "true" ? true : false;
        this.includeAttachments = gs.getProperty("addToUpdateSetUtils.include_attachments", "true") == "true" ? true : false;
        this.suppressPhotoAttachments = gs.getProperty("addToUpdateSetUtils.suppress_photo_attachments", "true") == "true" ? true : false;
        this.preventDefaultUpdateSet = gs.getProperty("addToUpdateSetUtils.prevent_default_updatesets", "true") == "true" ? true : false;
        this.preventProtectedNLUModels = gs.getProperty("addToUpdateSetUtils.prevent_protected_nlu_models", "true") == "true" ? true : false;
        this.includeDbViewTables = gs.getProperty("addToUpdateSetUtils.include_db_view_tables", "true") == "true" ? true : false;

        this.updateSetAPI = new GlideUpdateSet();
        this.clientSession = gs.getSession();

        //Variables for error handling
        this.scriptSysID = "6ba1c8a24f5da740d1676bd18110c79a";
        this.scriptAPIName = "global.addToUpdateSetUtils";

        //If records are added to an update set from certain tables, downstream issues may arise.
		//sys_translated_text records should never be included because of issues during the upgrade process.  They are automatically included within the parent XML record. Please see this KB article for details: https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0966221
        this.excludedTables = ["sys_translated_text"];
    },

    // Function leveraged by the Add to Update Set UI Action to control visibility
    checkDisplayCondition: function(tableRec) {
        var excludeTables = gs.getProperty("addToUpdateSetUtils.exclude_tables") + "";
        if (!gs.nil(excludeTables)){
			excludeTables = excludeTables.split(',');
			for (var z = 0; z < excludeTables.length; z++) {
				if (excludeTables[z].trim() == tableRec.getTableName()){
					return false;
				}
			}
        }

        var specificUsers = gs.getProperty("addToUpdateSetUtils.specific_users") + "";
        if (!gs.nil(specificUsers)){
            specificUsers = specificUsers.split(',');
			for (var z = 0; z < specificUsers.length; z++) {
				if (specificUsers[z].trim() == gs.getUserName()){
					return false;
				}
			}
        }

        // Default to show Add to Update Set UI Action
        return true;
    },

    addToUpdateSet: function(tableRec) {
        var userMessage = "";
        var currentSetID = this.updateSetAPI.get();
        if (this.preventDefaultUpdateSet == true && currentSetID == this.updateSetAPI.getDefault()) {
            var newLocalSetURL = '<a href="sys_update_set.do?sys_id=-1">New Local Update Set</a>';
            userMessage = "You are attempting to add a record to the system default update set, please create a " + newLocalSetURL + " and set that as your current update set.";
            gs.addErrorMessage(userMessage);
            return;
        }

        // Check to see if executing UI Action from a list or related list so that final message has all results
        var clearSessionVariables;
        var glideURIMap = gs.action.getGlideURI().getMap();
        var isList = glideURIMap.get("sys_is_list");
        isList = gs.nil(isList) ? false : isList;
        if (isList) {
            var listCheckedItems = this.clientSession.getClientData("listCheckedItems") + "";
            if (listCheckedItems == "null") {
                this.clientSession.putClientData("listCheckedItems", RP.getParameterValue("sysparm_checked_items"));
                clearSessionVariables = true;
            } else {
                clearSessionVariables = false;
                var recID = tableRec.getValue("sys_id");
                listCheckedItems = listCheckedItems.split(",");
                listCheckedItems.splice(listCheckedItems.indexOf(recID), 1);
                if (listCheckedItems.length > 0) {
                    this.clientSession.putClientData("listCheckedItems", listCheckedItems.toString());
                } else {
                    this.clientSession.clearClientData("listCheckedItems");
                }
            }
        } else {
            // Single record so clear variables and present confirmation message
            clearSessionVariables = true;
            this.clientSession.clearClientData("listCheckedItems");
        }

        // Session variables are utilized to store components used for the final confirmation message
        // Ensure session properties are clear and initialized
        this.clientSession.clearClientData("originalSet");
        this.clientSession.putClientData("originalSet", currentSetID);
        if (clearSessionVariables) {
            this.clientSession.clearClientData("setsUtilized");
            this.clientSession.putClientData("setsUtilized", "");
            this.clientSession.clearClientData("parentSet");
            this.clientSession.clearClientData("tablesUtilized");
            this.clientSession.putClientData("tablesUtilized", "");
            this.clientSession.clearClientData("warningMessages");
            this.clientSession.putClientData("warningMessages", "");
            this.clientSession.clearClientData("errorMessages");
            this.clientSession.putClientData("errorMessages", "");
            this.clientSession.clearClientData("listSummary");
        }

        // Check for table specific scripts and add item to update set
        try {
            // Check for table specific scripts and add item to update set
            var tableName = tableRec.getTableName();
            this.checkTable(tableRec, tableName);
        } catch (err) {
            var errorMessage = (err.message.endsWith(".")) ? err.message.slice(0, -1) : err.message;
            errorMessage = "The Add to Update Set Utility encountered an error: " + errorMessage;
            if (!gs.nil(err.stack)) {
                var fileName = err.fileName.indexOf(this.scriptSysID) == -1 ? err.fileName : this.scriptAPIName;
                var sourceName = err.sourceName.split(".");
                fileName = '<a href="' + sourceName[0] + ".do?sys_id=" + sourceName[1] + '" target="_blank">' + fileName + '</a>';
                errorMessage += " in script " + fileName + " on line number " + err.lineNumber.toString();
            }

            this._addErrorMessage(errorMessage);
        }

        // Set user's update set back to the original
        var originalSet = this.clientSession.getClientData("originalSet") + "";
        if (originalSet != "null") {
            if (this.updateSetAPI.get().toString() != originalSet) {
                this.updateSetAPI.set(originalSet);
            }
            this.clientSession.clearClientData("originalSet");
        }

        // Flush any messages generated by changing of update sets
        gs.flushMessages();

        userMessage = this.compileConfirmationMessage(isList);
        gs.addInfoMessage(userMessage);
    },

    compileConfirmationMessage: function(isList) {
        if (gs.nil(isList)) {
            isList = false;
        }

        var userMessage = "";
        var setsUtilized = this.clientSession.getClientData("setsUtilized") + "";

        if (!gs.nil(setsUtilized)) {
            var updateSetID = "";
            var parentSetID = this.clientSession.getClientData("parentSet") + "";

            if (isList) {
                setsUtilized = setsUtilized.split(",");

                // By default the parent update set is part of the list remove it if it exists so we can point to the right update set
                if (parentSetID != "null") {
                    setsUtilized.splice(setsUtilized.indexOf(parentSetID), 1);
                }

                if (setsUtilized.length == 1 || parentSetID == "null") {
                    updateSetID = setsUtilized[0];
                } else {
                    updateSetID = parentSetID;
                }
                this.clientSession.putClientData("listSummary", "yes");
                userMessage = 'Add to Update Set was utilized via list action.  Please <a href="sys_update_set.do?sys_id=' + updateSetID + '"><span style="color: #ff0000;">click here to view summary</span></a>.';
            } else {
                var updateSetList = [];
                var updateSetDetailList = {};
                var updateSet = new GlideRecord("sys_update_set");
                updateSet.addQuery("sys_id", "IN", setsUtilized);
                updateSet.query();
                while (updateSet.next()) {
                    updateSetID = updateSet.getValue("sys_id");
                    var updateSetDetails = {};
                    updateSetDetails.name = updateSet.getValue("name");
                    updateSetDetails.scope = updateSet.application.getDisplayValue();

                    if (parentSetID != updateSetID) {
                        updateSetList.push(updateSetID);
                    }
                    updateSetDetailList[updateSetID] = updateSetDetails;
                }

                if (updateSetList.length > 1) {
                    userMessage = '<p><span style="color: #ff0000;"><strong><a style="color: #ff0000;" href="' + this.updateSetBatchingURL + '" target="_blank">Update set batching</a>';
                    userMessage = userMessage + ' was utilized because multiple scopes were detected. Records added to following update sets:</strong></span></p>';
                    userMessage = userMessage + '<ul style="list-style-position: inside;">';
                    userMessage = userMessage + '<li><a href="sys_update_set.do?sys_id=' + parentSetID + '">' + updateSetDetailList[parentSetID].name + ' - ' + updateSetDetailList[parentSetID].scope + '</a></li>';
                    for (var i = 0; i < updateSetList.length; i++) {
                        userMessage = userMessage + '<li><a href="sys_update_set.do?sys_id=' + updateSetList[i] + '">' + updateSetDetailList[updateSetList[i]].name + ' - ' + updateSetDetailList[updateSetList[i]].scope + '</a></li>';
                    }
                    userMessage = userMessage + '</ul>';
                } else {
                    userMessage = '<p>Record(s) added to update set:</p>';
                    userMessage = userMessage + '<ul style="list-style-position: inside;"><li>';
                    userMessage = userMessage + '<a href="sys_update_set.do?sys_id=' + updateSetList[0] + '">' + updateSetDetailList[updateSetList[0]].name + ' - ' + updateSetDetailList[updateSetList[0]].scope + '</a></ul>';
                }

                var tablesUtilized = this.clientSession.getClientData("tablesUtilized") + "";
                tablesUtilized = tablesUtilized.split(",");
                if (tablesUtilized.length > 0) {
                    tablesUtilized.sort();
                    userMessage = userMessage + '<p>Record(s) from the following tables(s) added:</p>';
                    userMessage = userMessage + '<ul style="list-style-position: inside;"><li>' + tablesUtilized.join(", ") + '</li></ul>';
                }

                this.clientSession.clearClientData("setsUtilized");
                this.clientSession.clearClientData("parentSet");
                this.clientSession.clearClientData("tablesUtilized");
                this.clientSession.clearClientData("listSummary");
            }
        }

        var warningMessages = this.clientSession.getClientData("warningMessages") + "";
        if ((!isList || gs.nil(updateSetID)) && warningMessages != "null" && warningMessages.length > 0) {
            warningMessages = warningMessages.split(",");
            userMessage = userMessage + '<p><span style="color: #F4A460;"><strong>Warnings:</strong></span></p>';
            userMessage = userMessage + '<ul style="list-style-position: inside;">';
            for (var w = 0; w < warningMessages.length; w++) {
                if (gs.nil(warningMessages[w]) || warningMessages[w] == "null") continue;
                userMessage = userMessage + '<li>' + warningMessages[w] + '</li>';
            }
            userMessage = userMessage + '</ul>';
            this.clientSession.clearClientData("warningMessages");
        }

        var errorMessages = this.clientSession.getClientData("errorMessages") + "";
        if ((!isList || gs.nil(updateSetID)) && errorMessages != "null" && errorMessages.length > 0) {
            errorMessages = errorMessages.split(",");
            userMessage = userMessage + '<p><span style="color: #ff0000;"><strong>Errors - Please consult your System Administrator:</strong></span></p>';
            userMessage = userMessage + '<ul style="list-style-position: inside;">';
            for (var e = 0; e < errorMessages.length; e++) {
                if (gs.nil(errorMessages[e]) || errorMessages[e] == "null") continue;
                userMessage = userMessage + '<li>' + errorMessages[e] + '</li>';
            }
            userMessage = userMessage + '</ul>';
            this.clientSession.clearClientData("errorMessages");
        }

        return userMessage;
    },

    _addErrorMessage: function(errorMessage) {
        var errorMessages = this.clientSession.getClientData("errorMessages") + "";
        if (gs.nil(errorMessage) || errorMessage == "null" || errorMessages.indexOf(errorMessage) > -1) {
            //Error message null or already captured
            return;
        } else {
            // split adding an extra comma so checking length
            if (gs.nil(errorMessages) || errorMessages.length == 0) {
                errorMessages = [];
            } else {
                errorMessages = errorMessages.split(",");
            }

            errorMessages.push(errorMessage);
            this.clientSession.putClientData("errorMessages", errorMessages.toString());
        }
    },

    checkTable: function(tableRec, tableName) {
        var continueProcessing = true;
        var processParentTable = false;

        /*
         * Below specific tables can be called out however the next switch statement below allows you to use parent tables.
         * Example is with record producers which extend sc_cat_item and the components are the same.
         * If you want to not process parent tables, set processParentTable to false similar to example above.
         */

        switch (tableName) {
            /********************* Common Tables *************************************/
            case "sys_attachment":
                this._addAttachment(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_user":
                this._addUser(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_user_group":
                this._addGroup(tableRec, tableName);
                continueProcessing = false;
                break;
            case "asmt_metric_type":
                this._addAssessment(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_db_object":
                this._addDbObject(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_db_view":
                this._addDbView(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_dictionary":
                this._addField(tableRec, tableName);
                continueProcessing = false;
                break;
            case "item_option_new_set":
                this._addVariableSet(tableRec, tableName);
                break;
            case "sys_ui_form":
                this._addFormDependencies(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_security_acl":
                this._addACLDependencies(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_ui_policy":
                this._addUIPolicyDependencies(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_data_policy2":
                this._addDataPolicyDependencies(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_app_application":
                this._addAppModuleDependencies(tableRec, tableName);
                continueProcessing = false;
                break;
            case "dms_document":
                this._addManagedDoc(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_atf_test":
                this._addATF(tableRec, tableName);
                continueProcessing = false;
                break;
            case "cmn_schedule":
                this._addSchedule(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_embedded_tour_guide":
                this._addGuidedTour(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Workflow & Integration Tables *********************/
            case "wf_workflow":
                this._addWorkflow(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_cs_topic":
                this._addVirtualAgent(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_cb_topic":
                this._addVirtualAgent(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_nlu_model":
                this._addNLUModel(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_rest_message":
                this._addRestMessage(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_rest_message_fn":
                this._addRestFunction(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_ws_definition":
                this._addScriptedRestService(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_ws_operation":
                this._addScriptedRestResource(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_web_service":
                this._addScriptedSoapService(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_soap_message":
                this._addSoapMessage(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_soap_message_function":
                this._addSoapFunction(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_hub_flow":
                this._addFlow(tableRec, tableName);
                continueProcessing = false;
                break;
			case "sys_hub_action_type_definition":
                this._addFlowAction(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_transform_map":
                this._addTransformMap(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Service Portal Tables *****************************/
            case "sp_portal":
                this._addSPPortal(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sp_page":
                this._addSPPage(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sp_widget":
                this._addSPWidget(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sp_ng_template":
                this._addNgTemplate(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sp_angular_provider":
                this._addAngularProvider(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Reporting & PA Tables *****************************/
            case "sys_portal_page":
                this._addPortalPage(tableRec, tableName);
                continueProcessing = false;
                break;
            case "pa_dashboards":
                this._addPADashboard(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_ui_hp_publisher":
                this._addInteractiveFilter(tableRec, tableName);
                continueProcessing = false;
                break;
            case "sys_report":
                this._addReport(tableRec, tableName);
                continueProcessing = false;
                break;
            case "pa_widgets":
                this._addPAWidget(tableRec, tableName);
                continueProcessing = false;
                break;
            case "pa_cubes":
                this._addPAIndicatorSource(tableRec, tableName);
                continueProcessing = false;
                break;
            case "pa_indicators":
                this._addPAIndicator(tableRec, tableName);
                continueProcessing = false;
                break;
            case "pa_dimensions":
                this._addPABreakdownSource(tableRec, tableName);
                continueProcessing = false;
                break;
            case "pa_breakdowns":
                this._addPABreakdown(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Event Management Tables *****************************/
            case "em_match_rule":
                this._addEMRule(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Discovery Tables *****************************/
            case "discovery_schedule":
                this._addDiscoverySchedule(tableRec, tableName);
                continueProcessing = false;
                break;
            case "discovery_range":
                this._addDiscoveryRangeSet(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* ETL Tables *****************************/
            case "cmdb_inst_application_feed":
                this._addETL(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* AI Search Tables *****************************/
            case "sys_search_context_config":
                this._addSearchContext(tableRec, tableName);
                continueProcessing = false;
                break;
            case "ais_search_profile":
                this._addAiSearchProfile(tableRec, tableName);
                continueProcessing = false;
                break;
            case "ais_search_source":
                this._addAiSearchSource(tableRec, tableName);
                continueProcessing = false;
                break;
            case "ais_datasource":
                this._addAiSearchDatasource(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Taxonomy Tables *****************************/
            case "taxonomy":
                this._addTaxonomy(tableRec, tableName);
                continueProcessing = false;
                break;
            case "topic":
                this._addTaxonomyTopic(tableRec, tableName);
                continueProcessing = false;
                break; 
            case "sn_ex_sp_quick_link":
                this._addQuickLink(tableRec, tableName);
                continueProcessing = false;
                break;
			
			/********************* Change Management Tables *****************************/
            case "chg_model":
                this._addChangeModel(tableRec, tableName);
                continueProcessing = false;
                break;
			case "sttrm_state":
				this._addModelState(tableRec, tableName);
                continueProcessing = false;
                break;

            /********************* Decision Table Tables *****************************/
            case "sys_decision":
                this._addDecisionTable(tableRec, tableName);
                continueProcessing = false;
                break;
                
            default:
                processParentTable = true;
                break;
        }

        if (processParentTable) {
            // Check for table needs at parent table level
            var tableBase = this._getTableBase(tableName);
            switch (tableBase) {
                case "sc_cat_item":
                    this._addCatItem(tableRec, tableName);
                    continueProcessing = false;
                    break;
                case "kb_knowledge":
                    this._addKnowledge(tableRec, tableName);
                    continueProcessing = false;
                    break;
            }
        }

        //Since a table hasn't been found, check scope specific scripts to find a match, if not just add the single record to the update set
        if (continueProcessing) {
            if (this._executeScopeScript(tableRec, tableName)) {
                // Since no other tables
                this.saveRecord(tableRec);
            }
        }
    },

    _getTableBase: function(tableName) {
        return new global.TableUtils(tableName).getAbsoluteBase() + "";
    },

    _getTableHierarchy: function(tableName) {
        return new global.TableUtils(tableName).getHierarchy() + "";
    },

    /*
     * saveRecord input variables:
     * - tableRec = record that will be added to the update set
     * - validRecordCheck = by default saveRecord will validate that the record being added to the update set is an actual record in the database
     *       using the GlideRecord isValidRecord() function.  If you have a use case where you want to dynamically create a record and add it to
     *       an update set, set the parameter to false and the record will be added to the set.
     * - executeCustomScript = by default custom addToUpdateSetUtilsCustom scripts will be called after the primary record is added to the update set
     *       Set this parameter to false where you don't want to execute those scripts.
     *       It is SUPER IMPORTANT to set this parameter to false in your custom addToUpdateSetUtilsCustom scripts when calling the saveRecord function to
     *       prevent an infinite loop where saveRecord calls your custom addToUpdateSetUtilsCustom script which then calls saveRecord and so on.
     */
    saveRecord: function(tableRec, validRecordCheck, executeCustomScript) {
        var skipExcludedTable = false;
		for (var i = 0; i < this.excludedTables.length; i++) {
			if (this.excludedTables[i].toString().trim() == tableRec.getTableName()){
				skipExcludedTable = true;
			}
		}
		
		if (skipExcludedTable) {
            var errorMessage = "Records from the " + tableRec.getTableName() + " table cannot be added to update sets.  Record(s) skipped.";
            this._addErrorMessage(errorMessage);
            return;
        }

        if (gs.nil(validRecordCheck)) {
            validRecordCheck = true;
        }

        if (gs.nil(executeCustomScript)) {
            executeCustomScript = true;
        }

        if (validRecordCheck && !tableRec.isValidRecord()) {
            return;
        }

        //Run custom addToUpdateSetUtilsCustom scripts which allow customers to add their custom code to update sets
        if (executeCustomScript) {
            this._executeCustomScript(tableRec);
        }

        if (this._checkSetScope(tableRec) == false) {
            return;
        }

        var updateManager = new GlideUpdateManager2();
        updateManager.saveRecord(tableRec);

        //Check for and add any attachments to the update set if applicable
        if (this.includeAttachments) {
            this._addAttachments(tableRec);
        }

        //Check for and add any translations to the update set if applicable
        this._addTranslations(tableRec);

        //Check for and add application restricted caller acccess to the update set if applicable
        if (new GlidePluginManager().isActive("com.glide.scope.access.restricted_caller")) {
            this._addRestrictedCallerAccess(tableRec);
        }

        var tablesUtilized = this.clientSession.getClientData("tablesUtilized") + "";
        // split adding an extra comma so checking length
        if (tablesUtilized == "null" || tablesUtilized.length == 0) {
            tablesUtilized = [];
        } else {
            tablesUtilized = tablesUtilized.split(",");
        }
        var tableLabel = tableRec.getClassDisplayValue();
        if (tablesUtilized.indexOf(tableLabel) == -1) {
            tablesUtilized.push(tableLabel);
        }

        this.clientSession.putClientData("tablesUtilized", tablesUtilized.toString());
    },

    _executeScopeScript: function(tableRec, tableName) {
        var scriptQuery = "name=addToUpdateSetUtils^sys_scope!=global";
        return this._executeScript(scriptQuery, tableRec, tableName);
    },

    _executeCustomScript: function(tableRec, tableName) {
        var scriptQuery = "name=addToUpdateSetUtilsCustom";
        return this._executeScript(scriptQuery, tableRec, tableName);

    },

    _executeScript: function(scriptQuery, tableRec, tableName) {
        var continueProcessing = true;

        try {
            var scriptInclude = new GlideRecord("sys_script_include");
            scriptInclude.addEncodedQuery(scriptQuery);
            scriptInclude.query();
            while (scriptInclude.next()) {
                var apiName = scriptInclude.getValue("api_name");
                var scriptName = "new " + apiName + "()";
                var scopeScript = GlideEvaluator.evaluateString(scriptName);
                continueProcessing = scopeScript.checkTable(tableRec, tableName);
                if (continueProcessing == false) {
                    break;
                }
            }
        } catch (err) {
            var errorMessage = (err.message.endsWith(".")) ? err.message.slice(0, -1) : err.message;
            errorMessage = "The Add to Update Set Utility encountered an error: " + errorMessage;
            if (!gs.nil(err.stack)) {
                var fileName = apiName;
                var sourceName = err.sourceName.split(".");
                fileName = '<a href="' + sourceName[0] + ".do?sys_id=" + sourceName[1] + '" target="_blank">' + fileName + '</a>';
                errorMessage += " in script " + fileName + " on line number " + err.lineNumber.toString();
            }

            this._addErrorMessage(errorMessage);
            continueProcessing = false;
        }

        return continueProcessing;
    },

    _checkSetScope: function(tableRec) {
        var currentSetID = this.updateSetAPI.get();

        if (this.preventDefaultUpdateSet == true && currentSetID == this.updateSetAPI.getDefault()) {
            var newLocalSetURL = '<a href="sys_update_set.do?sys_id=-1">New Local Update Set</a>';
            userMessage = "You are attempting to add a record to the system default update set, please create a " + newLocalSetURL + " and set that as your current update set.";
            gs.addErrorMessage(userMessage);
            return false;
        }

        var newSetID = currentSetID;
        var setsUtilized = this.clientSession.getClientData("setsUtilized") + "";
        // split adding an extra comma so checking length
        if (setsUtilized == "null" || setsUtilized.length == 0) {
            setsUtilized = [];
        } else {
            setsUtilized = setsUtilized.split(",");
        }

        var currentSet = new GlideRecord("sys_update_set");
        currentSet.get(currentSetID);
        var currentSetName = currentSet.getValue("name");
        var currentSetScope = currentSet.getValue("application");
        var parentUpdateSetID = currentSet.getValue("base_update_set");

        var tableRecScope = this._getRecordScope(tableRec, "id");
        var createParentSet = gs.nil(currentSet.getValue("base_update_set"));
        var createChildSet = false;

        var updateSet = new GlideRecord("sys_update_set");
        if ((tableRecScope != currentSetScope && !gs.nil(parentUpdateSetID)) || currentSet.getValue("base_update_set") == currentSet.getValue("sys_id")) {
            updateSet.initialize();
            updateSet.addQuery("parent", parentUpdateSetID);
            updateSet.addQuery("application", tableRecScope);
            updateSet.query();
            if (updateSet.next()) {
                newSetID = updateSet.getValue("sys_id");

                //Verify update set is 'In Progress' otherwise change it
                if (updateSet.getValue("state") != "in progress") {
                    updateSet.state = "in progress";
                    updateSet.update();
                }
            } else {
                createChildSet = true;
            }
        } else if (tableRecScope != currentSetScope) {
            createChildSet = true;
        }

        if (createChildSet) {
            if (createParentSet) {
                // Create parent set
                updateSet.initialize();
                updateSet.get(currentSetID);
                updateSet.name = updateSet.getValue("name") + " - Batch Parent";
                updateSet.is_default = false;
                parentUpdateSetID = updateSet.insert();

                if (currentSetName.indexOf("- Batch Child") == -1) {
                    currentSet.name = currentSetName + " - Batch Child";
                }
                currentSet.parent = parentUpdateSetID;
                currentSet.update();
            }
            if (currentSetName.indexOf("- Batch Parent") > -1) {
                currentSet.name = currentSetName.replace("Batch Parent", "Batch Child");
            }
            currentSet.parent = parentUpdateSetID;
            currentSet.application = tableRecScope;
            currentSet.is_default = false;
            newSetID = currentSet.insert();
        }

        if (currentSetID.toString() != newSetID.toString()) {
            currentSetID = newSetID;
            this.updateSetAPI.set(currentSetID);
        }

        if (setsUtilized.toString().indexOf(currentSetID) == -1) {
            setsUtilized.push(currentSetID);
        }
        if (!gs.nil(parentUpdateSetID)) {
            if (setsUtilized.toString().indexOf(parentUpdateSetID) == -1) {
                setsUtilized.push(parentUpdateSetID);
            }
            var parentSet = this.clientSession.getClientData("parentSet");
            if (gs.nil(parentSet)) {
                this.clientSession.putClientData("parentSet", parentUpdateSetID.toString());
            }
        }
        this.clientSession.putClientData("setsUtilized", setsUtilized.toString());

        return true;
    },

    _getRecordScope: function(tableRec, returnFieldName) {
        // returnFieldName values are "id" for the sys_id of the sys_scope record or "name" for the scope name
        if (gs.nil(returnFieldName)) {
            returnFieldName = "id";
        }

        // Default to global
        var scopeDetails = {};
        scopeDetails.id = "global";
        scopeDetails.name = "global";

        if (tableRec.isValidField("sys_scope") && !gs.nil(tableRec.getValue("sys_scope"))) {
            scopeDetails.id = tableRec.sys_scope.toString();
            scopeDetails.name = tableRec.sys_scope.scope.toString();
        } else if (tableRec.getTableName() == "sys_choice") {
            var choiceSet = new GlideRecord("sys_choice_set");
            choiceSet.addQuery("name", tableRec.getValue("name"));
            choiceSet.addQuery("element", tableRec.getValue("element"));
            choiceSet.query();
            if (choiceSet.next()) {
                scopeDetails.id = choiceSet.sys_scope.toString();
                scopeDetails.name = choiceSet.sys_scope.scope.toString();
            }
            /* If returnFieldName == "name" as last resort check the sys_meta for the record's scope name
             * This is important when executing the scope scripts for table permission purposes and scope specific processing
             * This is NOT needed when the scope ID is needed when adding a record to an update set so that the Customer Updates are added to the right scope
             */
        } else if (returnFieldName == "name" && !gs.nil(tableRec.sys_meta) && !gs.nil(tableRec.sys_meta.sys_scope)) {
            scopeDetails.id = tableRec.sys_meta.sys_scope.toString();
            var sysApp = new GlideRecord("sys_scope");
            if (sysApp.get(scopeDetails.id)) {
                scopeDetails.name = sysApp.getValue("scope");
            }
        }

        return scopeDetails[returnFieldName];
    },

    /********************* Table Specific Functions *********************/

    /********************* Begin Attachment Functions *********************/
    //Add an attachment to the update set
    _addAttachment: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        this._addAttachmentDocs(tableRec, tableName);
    },

    //Add all record attachments to the update set
    _addAttachments: function(tableRec, tableName) {
        //If the current record *has* attachments, add those
        if (gs.nil(tableName)) {
            tableName = tableRec.getTableName();
        }

        //Process the main sys_attachment record
        var attach = new GlideRecord("sys_attachment");
        attach.addQuery("table_name", "CONTAINS", tableName); //Using contains search since images have a table prefix of ZZ_YY
        attach.addQuery("table_sys_id", tableRec.sys_id.toString());
        if (this.suppressPhotoAttachments) {
            attach.addQuery('content_type', '!=', 'image/png');
            attach.addQuery('content_type', '!=', 'image/jpeg');
            attach.addQuery('content_type', '!=', 'image/gif');
        }
        attach.query();
        while (attach.next()) {
            this.saveRecord(attach);

            //Process each sys_attachment_doc chunk
            this._addAttachmentDocs(attach, "sys_attachment");
        }
    },

    //Add attachment chunks to the update set
    _addAttachmentDocs: function(tableRec, tableName) {
        var attach_doc = new GlideRecord("sys_attachment_doc");
        attach_doc.addQuery("sys_attachment", tableRec.sys_id.toString());
        attach_doc.orderBy("position");
        attach_doc.query();
        while (attach_doc.next()) {
            this.saveRecord(attach_doc);
        }
    },
    /********************* End Attachment Functions *********************/

    //Add record translations to the update set
    _addTranslations: function(tableRec) {
        //If the current record *has* translations, add those

        // sys_translated_text records are automatically added with parent record and are part of this.excludedTables variable

        var tableHierarchy = new global.TableUtils(tableRec.getTableName()).getTables().toArray();
        // tableHierarchy isn't a real array so convert to array and remove sys_metadata
        var tableList = [];
        for (var i = 0; i < tableHierarchy.length; i++) {
            var tableName = tableHierarchy[i];
            if (!tableName.startsWith("sys_")) {
                tableList.push(tableName);
            }
        }
        var fieldList = [];
        var translatedField = new GlideAggregate("sys_translated");
        translatedField.addAggregate("count");
        translatedField.addAggregate("count(distinct", "element");
        translatedField.addQuery("name", "IN", tableList);
        translatedField.query();
        while (translatedField.next()) {
            var count = translatedField.getAggregate("count");
            if (count > 1) {
                fieldList.push(translatedField.element.toString());
            }
        }

        var translationList = [];
        for (var f = 0; f < fieldList.length; f++) {
            var fieldName = fieldList[f];
            translationList.push(tableRec.getValue(fieldName));
        }

        translatedField = new GlideRecord("sys_translated");
        translatedField.addQuery("name", "IN", tableList.toString());
        translatedField.addQuery("element", "IN", fieldList.toString());
        translatedField.addQuery("value", "IN", translationList.toString()).addOrCondition("label", "IN", translationList.toString());
        translatedField.query();
        while (translatedField.next()) {
            this.saveRecord(translatedField);
        }
    },

    _addRestrictedCallerAccess: function(tableRec) {
        var recID = tableRec.getValue("sys_id");
        var restrictedCallerAccess = new GlideRecord("sys_restricted_caller_access");
        restrictedCallerAccess.addQuery("status", 2); //Allowed
        restrictedCallerAccess.addQuery("source", recID).addOrCondition("target", recID);
        restrictedCallerAccess.query();
        while (restrictedCallerAccess.next()) {
            this.saveRecord(restrictedCallerAccess);
        }
    },

    /********************* Begin KB Functions *********************/
    //Add KB Article and all dependencies to the update set
    _addKnowledge: function(tableRec, tableName) {
        this._addKnowledgeArticle(tableRec, tableName);

        var canReadList = tableRec.can_read_user_criteria.toString().split(",");
        var cannotReadList = tableRec.cannot_read_user_criteria.toString().split(",");

        // Check to ensure Knowledge Blocks plugin is active
        if (new GlidePluginManager().isActive("com.snc.knowledge_blocks")) {
            var knowledgeBlockM2M = new GlideRecord("m2m_kb_to_block_history");
            knowledgeBlockM2M.addQuery("knowledge", tableRec.sys_id.toString());
            knowledgeBlockM2M.query();
            while (knowledgeBlockM2M.next()) {
                this.saveRecord(knowledgeBlockM2M);

                var knowledgeBlock = knowledgeBlockM2M.knowledge_block.getRefRecord();
                this._addKnowledgeArticle(knowledgeBlock, knowledgeBlock.getTableName());

                var userCriteriaID;
                var blockCanReadList = knowledgeBlock.can_read_user_criteria.toString().split(",");
                for (var c = 0; c < blockCanReadList.length; c++) {
                    userCriteriaID = blockCanReadList[c].toString();
                    if (canReadList.toString().indexOf(userCriteriaID) == -1) {
                        canReadList.push(userCriteriaID);
                    }
                }

                var blockCannotReadList = knowledgeBlock.cannot_read_user_criteria.toString().split(",");
                for (var n = 0; n < blockCannotReadList.length; n++) {
                    userCriteriaID = blockCannotReadList[n].toString();
                    if (cannotReadList.toString().indexOf(userCriteriaID) == -1) {
                        cannotReadList.push(userCriteriaID);
                    }
                }
            }
        }

        this._addUserCriteria(canReadList, cannotReadList);
    },

    _addKnowledgeArticle: function(tableRec, tableName) {
        this.saveRecord(tableRec);

        var kbCategory = tableRec.kb_category.getRefRecord();
        this.saveRecord(kbCategory);

        this._addAttachments(tableRec, tableName);

        // Check to ensure Knowledge Management Advanced plugin is active
        if (new GlidePluginManager().isActive("com.snc.knowledge_advanced")) {
            var kbVersion = tableRec.version.getRefRecord();
            this.saveRecord(kbVersion);

            var kbSummary = tableRec.summary.getRefRecord();
            this.saveRecord(kbSummary);
        }

        return tableRec;
    },
    /********************* End KB Functions *********************/

    //Add user record and dependencies to the update set
    _addUser: function(tableRec, tableName) {
        var userID;
        if (typeof tableRec == "string") {
            userID = tableRec;
            tableRec = new GlideRecord("sys_user");
            tableRec.get(userID);
        }
        this.saveRecord(tableRec);
        userID = tableRec.getValue("sys_id");

        var userRole = new GlideRecord("sys_user_has_role");
        userRole.addQuery("user", userID);
        userRole.addQuery("inherited", false);
        userRole.query();
        while (userRole.next()) {
            this.saveRecord(userRole);
        }

        var userGroup = new GlideRecord("sys_user_grmember");
        userGroup.addQuery("user", userID);
        userGroup.query();
        while (userGroup.next()) {
            this.saveRecord(userGroup);
        }

        var userDelegate = new GlideRecord("sys_user_delegate");
        userDelegate.addQuery("user", userID);
        userDelegate.query();
        while (userDelegate.next()) {
            this.saveRecord(userDelegate);
        }

        if (new GlidePluginManager().isActive("com.snc.skills_management")) {
            var userSkill = new GlideRecord("sys_user_has_skill");
            userSkill.addQuery("user", userID);
            userSkill.query();
            while (userSkill.next()) {
                this.saveRecord(userSkill);
            }
        }

        var liveProfile = new GlideRecord("live_profile");
        liveProfile.addQuery("document", userID);
        liveProfile.query();
        if (liveProfile.next()) {
            this.saveRecord(liveProfile);

            try {
                //Add community profile
                new sn_communities.addToUpdateSetUtils()._addCommunityProfile(liveProfile.getValue("sys_id"));
            } catch (err) {

            }
        }

        // Add HR Profile but check to ensure Human Resources Scoped App: Core plugin is active first
        if (new GlidePluginManager().isActive("com.sn_hr_core")) {
            try {
                new sn_hr_core.addToUpdateSetUtils()._addHRProfile(userID);
            } catch (err) {

            }
        }

        var bookmark = new GlideRecord("sys_ui_bookmark");
        bookmark.addQuery("user", userID);
        bookmark.query();
        while (bookmark.next()) {
            this.saveRecord(bookmark);
        }
    },

    //Add group record and dependencies to the update set
    _addGroup: function(tableRec, tableName) {
        var groupID;
        if (typeof tableRec == "string") {
            groupID = tableRec;
            tableRec = new GlideRecord("sys_user_group");
            tableRec.get(groupID);
        }
        this.saveRecord(tableRec);
        groupID = tableRec.getValue("sys_id");

        var groupTypes = tableRec.getValue("type");
        if (!gs.nil(groupTypes)) {
            var groupTypeList = groupTypes.toString().split(",");
            for (var i = 0; i < groupTypeList.length; i++) {
                var groupType = new GlideRecord("sys_user_group_type");
                if (groupType.get(groupTypeList[i])) {
                    this.saveRecord(groupType);
                }
            }
        }

        var groupRole = new GlideRecord("sys_group_has_role");
        groupRole.addQuery("group", groupID);
        groupRole.query();
        while (groupRole.next()) {
            this.saveRecord(groupRole);
        }

        if (this.includeUsersWithGroups && !gs.nil(tableRec.getValue("manager"))) {
            this._addUser(tableRec.getValue("manager"));
        }

        var groupMember = new GlideRecord("sys_user_grmember");
        groupMember.addQuery("group", groupID);
        groupMember.query();
        while (groupMember.next()) {
            this.saveRecord(groupMember);
            if (this.includeUsersWithGroups) {
                this._addUser(groupMember.getValue("user"));
            }
        }

        if (new GlidePluginManager().isActive("com.snc.skills_management")) {
            var groupSkill = new GlideRecord("sys_group_has_skill");
            groupSkill.addQuery("group", groupID);
            groupSkill.query();
            while (groupSkill.next()) {
                this.saveRecord(groupSkill);
            }
        }

        //Check for child groups and recursively gather them
        var childGroup = new GlideRecord("sys_user_group");
        childGroup.addQuery("parent", groupID);
        childGroup.query();
        while (childGroup.next()) {
            this._addGroup(childGroup);
        }
    },

    //Add schedule record and dependencies to the update set
    _addSchedule: function(tableRec, tableName) {
        var scheduleID;
        if (typeof tableRec == "string") {
            scheduleID = tableRec;
            tableRec = new GlideRecord("cmn_schedule");
            tableRec.get(scheduleID);
        }
        this.saveRecord(tableRec);
        scheduleID = tableRec.getValue("sys_id");

        //Add schedule entries
        var scheduleEntry = new GlideRecord("cmn_schedule_span");
        scheduleEntry.addQuery("schedule", scheduleID);
        scheduleEntry.query();
        while (scheduleEntry.next()) {
            this.saveRecord(scheduleEntry);
        }

        //Add child schedules
        var childSchedule = new GlideRecord("cmn_other_schedule");
        childSchedule.addQuery("schedule", scheduleID);
        childSchedule.query();
        while (childSchedule.next()) {
            this._addSchedule(childSchedule.child_schedule.toString());
            this.saveRecord(childSchedule);
        }
    },

    /********************* Begin Catalog & Workflow Functions *********************/
    //Add Catalog Item and all dependencies to the update set
    _addCatItem: function(tableRec, tableName) {
        this.saveRecord(tableRec);

        var catItemID = tableRec.sys_id.toString();

        var variableSetList = [];
        var variableSetM2M = new GlideRecord("io_set_item");
        variableSetM2M.addQuery("sc_cat_item", catItemID);
        variableSetM2M.query();
        while (variableSetM2M.next()) {
            this.saveRecord(variableSetM2M);
            var variableSet = variableSetM2M.variable_set.getRefRecord();
            this.saveRecord(variableSet);
            variableSetList.push(variableSet.sys_id.toString());
        }

        var variableQuery = "cat_item=" + catItemID;
        if (variableSetList.length > 0) {
            variableQuery = variableQuery + "^ORvariable_setIN" + variableSetList.toString();
        }

        this._addCatItemConfigDependencies(variableQuery);

        var availableForList = [];
        var availableForM2M = new GlideRecord("sc_cat_item_user_criteria_mtom");
        availableForM2M.addQuery("sc_cat_item", catItemID);
        availableForM2M.query();
        while (availableForM2M.next()) {
            this.saveRecord(availableForM2M);
            availableForList.push(availableForM2M.getValue("user_criteria"));
        }

        var notAvailableForList = [];
        var notAvailableForM2M = new GlideRecord("sc_cat_item_user_criteria_no_mtom");
        notAvailableForM2M.addQuery("sc_cat_item", catItemID);
        notAvailableForM2M.query();
        while (notAvailableForM2M.next()) {
            this.saveRecord(notAvailableForM2M);
            notAvailableForList.push(notAvailableForM2M.getValue("user_criteria"));
        }

        this._addUserCriteria(availableForList, notAvailableForList);

        var itemCategory = new GlideRecord("sc_cat_item_category");
        itemCategory.addQuery("sc_cat_item", catItemID);
        itemCategory.query();
        while (itemCategory.next()) {
            this.saveRecord(itemCategory);
            var scCategory = itemCategory.sc_category.getRefRecord();
            this.saveRecord(scCategory);
        }

        var itemCatalog = new GlideRecord("sc_cat_item_catalog");
        itemCatalog.addQuery("sc_cat_item", catItemID);
        itemCatalog.query();
        while (itemCatalog.next()) {
            this.saveRecord(itemCatalog);
            var scCatalog = itemCatalog.sc_catalog.getRefRecord();
            this.saveRecord(scCatalog);
        }

        if (!gs.nil(tableRec.workflow.toString())) {
            var itemWorkflow = tableRec.workflow.getRefRecord();
            this._addWorkflow(itemWorkflow);
        }

        if (tableRec.isValidField("flow_designer_flow") && !gs.nil(tableRec.flow_designer_flow.toString())) {
            this._addFlow(tableRec.flow_designer_flow.toString());
        }

        this._addServiceFulfillment(catItemID);

        if (!gs.nil(tableRec.template.toString())) {
            this._addTemplate(tableRec.template.toString());
        }

        if (tableName == "sc_cat_item_guide") {
            var orderGuideRule = new GlideRecord("sc_cat_item_guide_items");
            orderGuideRule.addQuery("guide", catItemID);
            orderGuideRule.query();
            while (orderGuideRule.next()) {
                this.saveRecord(orderGuideRule);

                // TODO recursively get cat items and child records
                var orderGuideRuleItem = orderGuideRule.item.getRefRecord();
                this.saveRecord(orderGuideRuleItem);

                var varAssignment = new GlideRecord("sc_item_variable_assignment");
                varAssignment.addQuery("rule", orderGuideRule.getValue("sys_id"));
                varAssignment.query();
                while (varAssignment.next()) {
                    this.saveRecord(varAssignment);
                }
            }
        }

        if (tableName == "pc_software_cat_item" || tableName == "pc_hardware_cat_item") {
            var vendorCatItem = new GlideRecord("pc_vendor_cat_item");
            vendorCatItem.addQuery("product_catalog_item", catItemID);
            vendorCatItem.query();
            while (vendorCatItem.next()) {
                this.saveRecord(vendorCatItem);
            }
        }
    },

    //Add workflow to the update set
    _addWorkflow: function(record, tableName) {
        this._gatherChildWorkflows(record);
        this.saveRecord(record);
    },

    //Recursively gather all child workflows
    _gatherChildWorkflows: function(workflow) {
        //Get published workflow version
        var workflowVersion = new GlideRecord("wf_workflow_version");
        workflowVersion.addQuery("workflow", workflow.sys_id.toString());
        workflowVersion.addQuery("published", true);
        workflowVersion.query();
        while (workflowVersion.next()) {
            //Get sub-workflow instances
            var subWorkflowInstance = new GlideRecord("wf_workflow_instance");
            subWorkflowInstance.addQuery("workflow_version", workflowVersion.sys_id.toString());
            subWorkflowInstance.query();
            while (subWorkflowInstance.next()) {
                //Get subWorkflows
                var subWorkflow = new GlideRecord("wf_workflow");
                subWorkflow.addQuery("sys_id", subWorkflowInstance.workflow.toString());
                subWorkflow.query();
                if (subWorkflow.next()) {
                    this._gatherChildWorkflows(subWorkflow);
                    this.saveRecord(subWorkflow);
                }
            }
        }
    },

    _addFlow: function(tableRec, tableName) {
        var recID;
		if (typeof tableRec == "string") {
            recID = tableRec;
            tableRec = new GlideRecord("sys_hub_flow");
            tableRec.get(recID);
        }
		recID = tableRec.getValue("sys_id");

        // The NY release flattens flows into a single sys_update_xml like workflows but prior releases have multiple components.
        // Only allow flows to be added to the update set if instance is on NY or later
        var instanceBuild = gs.getProperty("glide.buildname");
        if (instanceBuild >= "Newyork") {
            this.saveRecord(tableRec);

            // The composite flow sys_update_xml doesn't include a necessary record when inputs are "complex" such as Object
            // Check to see if there are any complex inputs and add those since sys_complex_object records are not automatically added
            var stringMatch = "co_type_name=";
            var objectIDs = [];
            var flowInput = new GlideRecord("sys_hub_flow_input");
            flowInput.addQuery("model", recID);
            flowInput.addQuery("attributes", "CONTAINS", "uiType=object");
            flowInput.addQuery("attributes", "CONTAINS", stringMatch);
            flowInput.query();
            while (flowInput.next()) {
                var attributeList = flowInput.getValue("attributes").toString().split(",");
                for (var i = 0; i < attributeList.length; i++) {
                    var attribute = attributeList[i];
                    if (attribute.startsWith(stringMatch)) {
                        var attributeValue = attribute.replace(stringMatch, "");
                        objectIDs.push(attributeValue);
                    }
                }
            }
            if (objectIDs.length > 0) {
                var complexObject = new GlideRecord("sys_complex_object");
                complexObject.addQuery("name", "IN", objectIDs.toString());
                complexObject.query();
                while (complexObject.next()) {
                    this.saveRecord(complexObject);
                }
            }
        } else {
            var warningMessages = this.clientSession.getClientData("warningMessages") + "";
            // split adding an extra comma so checking length
            if (warningMessages.length == 0) {
                warningMessages = [];
            } else {
                warningMessages = warningMessages.split(",");
            }
            var warningMessage = '<a href="' + tableRec.getLink() + '" target="_blank">' + tableRec.getDisplayValue() + '</a> ' + tableRec.getClassDisplayValue();
            warningMessage = warningMessage + " could not be added to the update set because this instance isn't on NY or higher.";
            if (warningMessages.indexOf(warningMessage) == -1) {
                warningMessages.push(warningMessage);
            }
            this.clientSession.putClientData("warningMessages", warningMessages.toString());
        }
    },
	
	_addFlowAction: function(tableRec, tableName) {
		var recID;
		if (typeof tableRec == "string") {
			recID = tableRec;
			tableRec = new GlideRecord("sys_hub_action_type_definition");
			tableRec.get(recID);
		}
		recID = tableRec.getValue("sys_id");
		this.saveRecord(tableRec);

		// The action sys_update_xml doesn't include a necessary record when inputs are "complex" such as Object
		// Check to see if there are any complex inputs and add those since sys_complex_object records are not automatically added
		var stringMatch = "co_type_name=";
		var objectIDs = [];
		var actionInput = new GlideRecord("sys_hub_action_input");
		actionInput.addQuery("model", recID);
		actionInput.addQuery("attributes", "CONTAINS", "uiType=object");
		actionInput.addQuery("attributes", "CONTAINS", stringMatch);
		actionInput.query();
		while (actionInput.next()) {
			var attributeList = actionInput.getValue("attributes").toString().split(",");
			for (var i = 0; i < attributeList.length; i++) {
				var attribute = attributeList[i];
				if (attribute.startsWith(stringMatch)) {
					var attributeValue = attribute.replace(stringMatch, "");
					objectIDs.push(attributeValue);
				}
			}
		}
		if (objectIDs.length > 0) {
			var complexObject = new GlideRecord("sys_complex_object");
			complexObject.addQuery("name", "IN", objectIDs.toString());
			complexObject.query();
			while (complexObject.next()) {
				this.saveRecord(complexObject);
			}
		}
	},

    //Add Service Fulfillment Stages & Steps
    _addServiceFulfillment: function(catItemID) {
        var serviceFulfillmentStage = new GlideRecord('sc_service_fulfillment_stage');
        serviceFulfillmentStage.addQuery('cat_item',catItemID);
        serviceFulfillmentStage.query();
        while (serviceFulfillmentStage.next()){
            this.saveRecord(serviceFulfillmentStage);
            var serviceFulfillmentStep = new GlideRecord('sc_service_fulfillment_step');
            serviceFulfillmentStep.addQuery('service_fulfillment_stage',serviceFulfillmentStage.sys_id.toString());
            serviceFulfillmentStep.query();
            while (serviceFulfillmentStep.next()){
                this.saveRecord(serviceFulfillmentStep);
            }
        }
    },

    //Add variable set to the update set
    _addVariableSet: function(tableRec, tableName) {
        var variableQuery = "variable_set=" + tableRec.sys_id.toString();
        this._addCatItemConfigDependencies(variableQuery);
        this.saveRecord(tableRec);
    },

    //Add variables, client scripts, and UI policies to the update set
    _addCatItemConfigDependencies: function(itemQuery) {
        var warningMessages = this.clientSession.getClientData("warningMessages") + "";
        // split adding an extra comma so checking length
        if (warningMessages.length == 0) {
            warningMessages = [];
        } else {
            warningMessages = warningMessages.split(",");
        }

        var variableList = [];
        var variables = new GlideRecord("item_option_new");
        variables.addEncodedQuery(itemQuery);
        variables.query();
        while (variables.next()) {
            this.saveRecord(variables);

            if ((variables.getValue("map_to_field") == true && variables.field.toString().startsWith("u_")) || variables.name.toString().startsWith("u_")) {
				var warningMessage;
				if (!gs.nil(variables.cat_item)) {
					var catItem = variables.cat_item.getRefRecord();
					warningMessage = '<a href="' + catItem.getLink() + '" target="_blank">' + catItem.getDisplayValue() + ' ' + catItem.getClassDisplayValue() + '</a>';
				} else if (!gs.nil(variables.variable_set)) {
					var varSet = variables.variable_set.getRefRecord();
                    warningMessage = '<a href="' + varSet.getLink() + '" target="_blank">' + varSet.getDisplayValue() + ' variable set</a>';
                }
				warningMessage = warningMessage + " contains variables mapped to custom fields that may need to be added to your update set.";
				if (warningMessages.indexOf(warningMessage) == -1) {
					warningMessages.push(warningMessage);
				}
			}
            variableList.push(variables.getValue("sys_id"));
        }
        this.clientSession.putClientData("warningMessages", warningMessages.toString());

        var questionChoice = new GlideRecord("question_choice");
        questionChoice.addQuery("question", "IN", variableList.toString());
        questionChoice.query();
        while (questionChoice.next()) {
            this.saveRecord(questionChoice);
        }

        var clientScript = new GlideRecord("catalog_script_client");
        clientScript.addEncodedQuery(itemQuery);
        clientScript.query();
        while (clientScript.next()) {
            this.saveRecord(clientScript);
        }

        var uiPolicyList = [];
        var uiPolicyQuery = itemQuery.replace("cat_item=", "catalog_item=");
        var uiPolicy = new GlideRecord("catalog_ui_policy");
        uiPolicy.addEncodedQuery(uiPolicyQuery);
        uiPolicy.query();
        while (uiPolicy.next()) {
            this.saveRecord(uiPolicy);
            uiPolicyList.push(uiPolicy.sys_id.toString());
        }

        var uiPolicyAction = new GlideRecord("catalog_ui_policy_action");
        uiPolicyAction.addQuery("ui_policy", "IN", uiPolicyList.toString());
        uiPolicyAction.query();
        while (uiPolicyAction.next()) {
            this.saveRecord(uiPolicyAction);
        }
    },

    _addUserCriteria: function(availableForList, notAvailableForList) {
        var arrayUtil = new global.ArrayUtil();
        var userCriteriaList = arrayUtil.concat(availableForList, notAvailableForList);
        var userCriteria = new GlideRecord("user_criteria");
        userCriteria.addQuery("sys_id", "IN", userCriteriaList.toString());
        userCriteria.query();
        while (userCriteria.next()) {
            this.saveRecord(userCriteria);
        }

        try {
            // Check for linked HR Criteria
            new sn_hr_core.addToUpdateSetUtils()._addHRCriteria("related_user_criteria", userCriteriaList.toString());
        } catch (err) {

        }
    },

    _addTemplate: function(templateID) {
        var template = new GlideRecord("sys_template");
        if (template.get(templateID)) {
            this.saveRecord(template);
        }
    },

    /********************* End Catalog & Workflow Functions *********************/

    /********************* Begin Reporting and PA Functions *********************/
    //Add PA Dashboard and all contents to the update set
    _addPADashboard: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var dashboardID = tableRec.getValue("sys_id");

        var groupID = tableRec.getValue("group");
        if (!gs.nil(groupID)) {
            var dashboardGroup = tableRec.group.getRefRecord();
            this.saveRecord(dashboardGroup);
        }

        var breakdownSourceM2M = new GlideRecord("pa_m2m_dashboard_sources");
        breakdownSourceM2M.addQuery("dashboard", dashboardID);
        breakdownSourceM2M.query();
        while (breakdownSourceM2M.next()) {
            this.saveRecord(breakdownSourceM2M);

            // Add Filter
            var actAsFilter = breakdownSourceM2M.getValue("publisher");
            if (!gs.nil(actAsFilter)) {
                this._addInteractiveFilter(actAsFilter);
            }

            //Add report source
            var breakdownSource = breakdownSourceM2M.getValue("breakdown_source");
            if (!gs.nil(breakdownSource)) {
                this._addPABreakdownSource(breakdownSource);
            }

        }

        var dashboardPermission = new GlideRecord("pa_dashboards_permissions");
        dashboardPermission.addQuery("dashboard", dashboardID);
        dashboardPermission.query();
        while (dashboardPermission.next()) {
            this.saveRecord(dashboardPermission);
        }

        var portalPageList = [];
        var dashboardTabM2M = new GlideRecord("pa_m2m_dashboard_tabs");
        dashboardTabM2M.addQuery("dashboard", dashboardID);
        dashboardTabM2M.query();
        while (dashboardTabM2M.next()) {
            this.saveRecord(dashboardTabM2M);

            var dashboardTab = dashboardTabM2M.tab.getRefRecord();
            this.saveRecord(dashboardTab);

            var portalPageID = dashboardTab.getValue("page");
            if (!gs.nil(portalPageID)) {
                portalPageList.push(dashboardTab.getValue("page"));
            }

            var canvasPageID = dashboardTab.getValue("canvas_page");
            if (!gs.nil(canvasPageID)) {
                var canvasPage = dashboardTab.canvas_page.getRefRecord();
                this.saveRecord(canvasPage);

                if (!gs.nil(canvasPage.getValue("legacy_page"))) {
                    portalPageList.push(canvasPage.getValue("legacy_page"));
                }

                var canvasPane = new GlideRecord("sys_grid_canvas_pane");
                canvasPane.addQuery("grid_canvas", canvasPageID);
                canvasPane.query();
                while (canvasPane.next()) {
                    this.saveRecord(canvasPane);
                    var pageID;
                    if (!gs.nil(canvasPane.getValue("portal_widget"))) {
                        pageID = canvasPane.portal_widget.page.toString();
                        if (!gs.nil(pageID)) {
                            portalPageList.push(pageID);
                        }
                    }
                }
            }
        }

        var portalPage = new GlideRecord("sys_portal_page");
        portalPage.addQuery("sys_id", "IN", portalPageList.toString());
        portalPage.query();
        while (portalPage.next()) {
            this._addPortalPage(portalPage);
        }
    },

    //Add Homepage and all contents to the update set
    _addPortalPage: function(portalPage, tableName) {
        // Since unloader drops a bunch of files, check the update set scope before calling unloader
        this._checkSetScope(portalPage);
        GlideappHome.unloader(portalPage);

        //Gather dropzones and contents for a homepage
        this._addSysPortal(portalPage.getValue("sys_id"));
    },

    //Gather dropzones and contents for a homepage
    _addSysPortal: function(portalID) {
        var sysPortal = new GlideRecord("sys_portal");
        sysPortal.addQuery("page", portalID);
        sysPortal.query();
        while (sysPortal.next()) {
            var recID = sysPortal.getValue("sys_id");
            // Because of cross references track the sys_portal records added and return if it has already been added
            if (gs.nil(this.PAData)) {
                this.PAData = {};
                this.PAData.sysPortalIDs = [];
                this.PAData.indicatorIDs = [];
                this.PAData.breakdownIDs = [];
            }

            if (this.PAData.sysPortalIDs.indexOf(recID) == -1) {
                this.PAData.sysPortalIDs.push(recID);
            } else {
                return;
            }

            this.saveRecord(sysPortal);
            var portalPreferenceObject = {};

            var portalPreference = new GlideRecord("sys_portal_preferences");
            portalPreference.addQuery("portal_section", recID);
            portalPreference.query();
            while (portalPreference.next()) {
                //this.saveRecord(portalPreference); //automatically added by GlideappHome.unloader(portalPage);
                portalPreferenceObject[portalPreference.getValue("name")] = portalPreference.getValue("value");
            }

            // Add renderer components, other renderers can also be added
            if (!gs.nil(portalPreferenceObject.renderer) && !gs.nil(portalPreferenceObject.sys_id)) {
                switch (portalPreferenceObject.renderer.toString()) {
                    case "com.glide.ui.portal.RenderReport":
                        this._addReport(portalPreferenceObject.sys_id);
                        break;
                    case "com.snc.pa.ui.RenderPerformanceAnalytics":
                        this._addPAWidget(portalPreferenceObject.sys_id);
                        break;
                    case "com.glide.ui.portal.RenderDashboard":
                        this._addHPGauge(portalPreferenceObject.sys_id);
                        break;
                    case "com.glide.cms.RenderBlock":
                        this._addHPStaticContent(portalPreferenceObject.sys_id);
                        break;
                }
            }
        }
    },

    //Add Report and contents to the update set
    _addReport: function(sysReport, tableName) {
        var recID;
        if (typeof sysReport == "string") {
            recID = sysReport;
            tableName = gs.nil(tableName) ? "sys_report" : tableName;
            sysReport = new GlideRecord(tableName);
            sysReport.get(recID);
        }
        recID = sysReport.getValue("sys_id");
        //Out of the box there are some orphaned report maps, validate it and if it is not valid, blank it out
        var reportMap = new GlideRecord("sys_report_map");
        if (!reportMap.get(sysReport.getValue("map"))) {
            sysReport.map = "";
        } else {
            //Add map source
            var mapSource = new GlideRecord("sys_report_map_source");
            if (mapSource.get(sysReport.getValue("map_source"))) {
                this.saveRecord(mapSource);
            }
        }

        this.saveRecord(sysReport);

        //Add report colors
        this._addReportColors(sysReport);

        //Add report color scheme
        var reportColorScheme = new GlideRecord("pa_chart_color_schemes");
        if (reportColorScheme.get(sysReport.getValue("color_pallete"))) {
            this.saveRecord(reportColorScheme);
        }

        //Add report chart colors
        this._addReportChartColors(sysReport);

        //Add report source
		var reportSourceIDs = [];
		var reportSourceID = sysReport.getValue("report_source");
		if (!gs.nil(reportSourceID)) {
			reportSourceIDs.push(reportSourceID);
		}
		
		//Add report layers / datasets
        var reportLayer = new GlideRecord("sys_report_layer");
        reportLayer.addQuery("report", recID);
        reportLayer.query();
		while (reportLayer.next()) {
			this.saveRecord(reportLayer);
			
			reportSourceID = reportLayer.getValue("report_source");
			if (!gs.nil(reportSourceID)) {
				reportSourceIDs.push(reportSourceID);
			}
		}
		
		//Add report source
        var reportSource = new GlideRecord("sys_report_source");
		reportSource.addQuery("sys_id", "IN", reportSourceIDs.toString());
		reportSource.query();
        while (reportSource.next()) {
            this.saveRecord(reportSource);
        }

        //Add report header footer template
        var reportHeaderFooter = new GlideRecord("sys_report_page_hdrftr");
        if (reportHeaderFooter.get(sysReport.getValue("page_hdrftr"))) {
            this.saveRecord(reportHeaderFooter);
        }

        //Add report drilldown
        var reportDrillID = sysReport.getValue("report_drilldown");
        if (!gs.nil(reportDrillID)) {
            this._addReport(reportDrillID, "sys_report_drill");
        }

        //Add report users/groups
        var reportUsersGroups = new GlideRecord("sys_report_users_groups");
        reportUsersGroups.addQuery("report_id", recID);
        reportUsersGroups.query();
        while (reportUsersGroups.next()) {
            this.saveRecord(reportUsersGroups);
        }

        //Add email report schedules
        var sysautoReport = new GlideRecord("sysauto_report");
        sysautoReport.addQuery("report", recID);
        sysautoReport.query();
        while (sysautoReport.next()) {
            this.saveRecord(sysautoReport);
        }

        //Add multilevel pivot rules
        var multilevelPivotRule = new GlideRecord("sys_report_mpivot_rule");
        multilevelPivotRule.addQuery("report_id", recID);
        multilevelPivotRule.query();
        while (multilevelPivotRule.next()) {
            this.saveRecord(multilevelPivotRule);
        }
    },

    _addPAWidget: function(paWidget, tableName) {
        var recID;
        if (typeof paWidget == "string") {
            recID = paWidget;
            paWidget = new GlideRecord("pa_widgets");
            paWidget.get(recID);
        }
        recID = paWidget.getValue("sys_id");
        this.saveRecord(paWidget);

        var fieldName;

        //Add Indicators
        var indicatorID = paWidget.getValue("indicator");
        if (!gs.nil(indicatorID)) {
            this._addPAIndicator(indicatorID);
        }

        var indicatorGroupID = paWidget.getValue("tag");
        if (!gs.nil(indicatorGroupID)) {
            this._addPAIndicatorGroup(indicatorGroupID);
        }

        //Add Breakdowns
        var breakdownFieldList = ["breakdown", "breakdown_level2", "followed_breakdown", "pivot_breakdown"];
        for (var b = 0; b < breakdownFieldList.length; b++) {
            fieldName = breakdownFieldList[b];
            if (paWidget.isValidField(fieldName) && !gs.nil(paWidget.getValue(fieldName))) {
                this._addPABreakdown(paWidget.getValue(fieldName));
            }
        }

        //Add report colors
        this._addReportColors(paWidget);

        //Add element filter
        var filterFieldList = ["elements_filter", "pivot_elements_filter"];
        for (var f = 0; f < filterFieldList.length; f++) {
            fieldName = filterFieldList[f];
            if (paWidget.isValidField(fieldName) && !gs.nil(paWidget.getValue(fieldName))) {
                this._addPAFilter(paWidget.getValue(fieldName));
            }
        }

        var widgetIndicator = new GlideRecord("pa_widget_indicators");
        widgetIndicator.addQuery("widget", recID);
        widgetIndicator.query();
        while (widgetIndicator.next()) {
            this.saveRecord(widgetIndicator);

            indicatorID = widgetIndicator.getValue("indicator");
            if (!gs.nil(indicatorID)) {
                this._addPAIndicator(indicatorID);
            }

            //Add Breakdowns
            breakdownFieldList = ["breakdown", "breakdown_level2", "followed_breakdown"];
            for (var bI = 0; bI < breakdownFieldList.length; bI++) {
                fieldName = breakdownFieldList[bI];
                if (widgetIndicator.isValidField(fieldName) && !gs.nil(widgetIndicator.getValue(fieldName))) {
                    this._addPABreakdown(widgetIndicator.getValue(fieldName));
                }
            }

            if (widgetIndicator.isValidField("color") && !gs.nil(widgetIndicator.getValue("color"))) {
                reportColor = new GlideRecord("sys_report_color");
                if (reportColor.get(widgetIndicator.getValue("color"))) {
                    this.saveRecord(reportColor);
                }
            }

            if (widgetIndicator.isValidField("elements_filter") && !gs.nil(widgetIndicator.getValue("elements_filter"))) {
                this._addPAFilter(widgetIndicator.getValue("elements_filter"));
            }
        }

        var onClickBehavior = new GlideRecord("widget_navigation");
        onClickBehavior.addQuery("widget", recID);
        onClickBehavior.query();
        while (onClickBehavior.next()) {
            this.saveRecord(onClickBehavior);
        }
    },

    _addPAIndicatorGroup: function(indicatorGroup, tableName) {
        var recID;
        if (typeof indicatorGroup == "string") {
            recID = indicatorGroup;
            indicatorGroup = new GlideRecord("pa_tags");
            indicatorGroup.get(recID);
        }
        recID = indicatorGroup.getValue("sys_id");
        this.saveRecord(indicatorGroup);

        var indicatorGroupM2M = new GlideRecord("pa_m2m_indicator_tags");
        indicatorGroupM2M.addQuery("tag", recID);
        indicatorGroupM2M.query();
        while (indicatorGroupM2M.next()) {
            this.saveRecord(indicatorGroupM2M);
            this._addPAIndicator(indicatorGroupM2M.getValue("indicator"));
        }
    },

    _addPAIndicatorSource: function(indicatorSource, tableName) {
        var recID;
        if (typeof indicatorSource == "string") {
            recID = indicatorSource;
            indicatorSource = new GlideRecord("pa_cubes");
            indicatorSource.get(recID);
        }
        recID = indicatorSource.getValue("sys_id");
        this.saveRecord(indicatorSource);

        var reportSource = new GlideRecord("sys_report_source");
        if (reportSource.get(indicatorSource.getValue("report_source"))) {
            this.saveRecord(reportSource);
        }

        var indicator = new GlideRecord("pa_indicators");
        indicator.addQuery("cube", recID);
        indicator.query();
        while (indicator.next()) {
            this._addPAIndicator(indicator);
        }

        var textIndexConfig = new GlideRecord("pa_text_index_configurations");
        textIndexConfig.addQuery("cube", recID);
        textIndexConfig.query();
        while (textIndexConfig.next()) {
            this.saveRecord(textIndexConfig);
        }
    },

    _addPAIndicator: function(indicator, tableName) {
        var recID;
        if (typeof indicator == "string") {
            recID = indicator;
            indicator = new GlideRecord("pa_indicators");
            indicator.get(recID);
        }

        if (!indicator.isValidRecord()) {
            return;
        }

        recID = indicator.getValue("sys_id");

        // Because of cross references track the pa_indicators records added and return if it has already been added
        if (gs.nil(this.PAData)) {
            this.PAData = {};
            this.PAData.sysPortalIDs = [];
            this.PAData.indicatorIDs = [];
            this.PAData.breakdownIDs = [];
        }

        if (this.PAData.indicatorIDs.indexOf(recID) == -1) {
            this.PAData.indicatorIDs.push(recID);
        } else {
            return;
        }

        this.saveRecord(indicator);

        var indicatorSourceID = indicator.getValue("cube");
        if (!gs.nil(indicatorSourceID)) {
            var indicatorSource = new GlideRecord("pa_cubes");
            if (indicatorSource.get(indicatorSourceID)) {
                this.saveRecord(indicatorSource);
            }
        }

        var unitID = indicator.getValue("unit");
        if (!gs.nil(unitID)) {
            var unit = new GlideRecord("pa_units");
            if (unit.get(unitID)) {
                this.saveRecord(unit);
            }
        }

        var linkedIndicatorID = indicator.getValue("linked_indicator");
        if (!gs.nil(linkedIndicatorID)) {
            this._addPAIndicator(linkedIndicator);
        }

        var managingIndicatorID = indicator.getValue("managing_indicator");
        if (!gs.nil(managingIndicatorID)) {
            this._addPAIndicator(managingIndicator);
        }

        var paScriptID = indicator.getValue("script");
        if (!gs.nil(paScriptID)) {
            this._addPAScript(paScriptID);
        }

        var paIndicatorBreakdown = new GlideRecord("pa_indicator_breakdowns");
        paIndicatorBreakdown.addQuery("indicator", recID);
        paIndicatorBreakdown.query();
        while (paIndicatorBreakdown.next()) {
            this.saveRecord(paIndicatorBreakdown);
            this._addPABreakdown(paIndicatorBreakdown.getValue("breakdown"));
        }

        this._addPATarget("indicator=" + recID);
        this._addPAThreshold("indicator=" + recID);

        var jobIndicator = new GlideRecord("pa_job_indicators");
        jobIndicator.addQuery("indicator", recID);
        jobIndicator.query();
        while (jobIndicator.next()) {
            this.saveRecord(jobIndicator);
            var paJob = new GlideRecord("sysauto_pa");
            if (paJob.get(jobIndicator.getValue("job"))) {
                this.saveRecord(paJob);
            }

            var jobIndicatorBreakdownExclusion = new GlideRecord("pa_job_indicator_breakdown_ex");
            jobIndicatorBreakdownExclusion.addQuery("job_indicator", jobIndicator.getValue("sys_id"));
            jobIndicatorBreakdownExclusion.query();
            while (jobIndicatorBreakdownExclusion.next()) {
                this.saveRecord(jobIndicatorBreakdownExclusion);
            }
        }

        var textIndexConfigM2M = new GlideRecord("pa_m2m_indicator_text_indexes");
        textIndexConfigM2M.addQuery("indicator", recID);
        textIndexConfigM2M.query();
        while (textIndexConfigM2M.next()) {
            this.saveRecord(textIndexConfigM2M);

            var textIndexConfig = new GlideRecord("pa_text_index_configurations");
            if (textIndexConfig.get(textIndexConfigM2M.getValue("text_index_configuration"))) {
                this.saveRecord(textIndexConfig);
            }
        }
    },

    _addPABreakdownSource: function(breakdownSource, tableName) {
        var recID;
        if (typeof breakdownSource == "string") {
            recID = breakdownSource;
            breakdownSource = new GlideRecord("pa_dimensions");
            breakdownSource.get(recID);
        }
        recID = breakdownSource.getValue("sys_id");
        this.saveRecord(breakdownSource);

        //Check of facts table is Bucket (pa_buckets) and add those records if so
        if (breakdownSource.getValue("facts_table") == "pa_buckets") {
            var templateObject = this.parseTemplateString(breakdownSource.conditions.toString());
            var bucketGroupID = templateObject.bucket_group;
            if (!gs.nil(bucketGroupID)) {
                var bucketGroup = new GlideRecord("pa_bucket_groups");
                if (bucketGroup.get(bucketGroupID)) {
                    this.saveRecord(bucketGroup);

                    var bucket = new GlideRecord("pa_buckets");
                    bucket.addQuery("bucket_group", bucketGroupID);
                    bucket.query();
                    while (bucket.next()) {
                        this.saveRecord(bucket);
                    }
                }
            }
        }

        var paBreakdown = new GlideRecord("pa_breakdowns");
        paBreakdown.addQuery("dimension", recID);
        paBreakdown.query();
        while (paBreakdown.next()) {
            this._addPABreakdown(paBreakdown);
        }
    },

    _addPABreakdown: function(paBreakdown, tableName) {
        var recID;
        if (typeof paBreakdown == "string") {
            recID = paBreakdown;
            paBreakdown = new GlideRecord("pa_breakdowns");
            paBreakdown.get(recID);
        }
        recID = paBreakdown.getValue("sys_id");

        // Because of cross references track the pa_breakdowns records added and return if it has already been added
        if (gs.nil(this.PAData)) {
            this.PAData = {};
            this.PAData.sysPortalIDs = [];
            this.PAData.indicatorIDs = [];
            this.PAData.breakdownIDs = [];
        }

        if (this.PAData.breakdownIDs.indexOf(recID) == -1) {
            this.PAData.breakdownIDs.push(recID);
        } else {
            return;
        }

        this.saveRecord(paBreakdown);

        var breakdownSourceID = paBreakdown.getValue("dimension");
        if (!gs.nil(breakdownSourceID)) {
            var breakdownSource = new GlideRecord("pa_dimensions");
            if (breakdownSource.get(breakdownSourceID)) {
                this.saveRecord(breakdownSource);
            }
        }

        var elementsFilterID = paBreakdown.getValue("default_filter");
        if (!gs.nil(elementsFilterID)) {
            this._addPAFilter(elementsFilterID);
        }

        var paScriptID = paBreakdown.getValue("script");
        if (!gs.nil(paScriptID)) {
            this._addPAScript(paScriptID);
        }

        var manualBreakdowns = new GlideRecord("pa_manual_breakdowns");
        manualBreakdowns.addQuery("breakdown", recID);
        manualBreakdowns.query();
        while (manualBreakdowns.next()) {
            this.saveRecord(manualBreakdowns);
        }

        this._addPATarget("breakdown=" + recID + "^ORbreakdown_level2=" + recID);
        this._addPAThreshold("breakdown=" + recID + "^ORbreakdown_level2=" + recID);

        var breakdownMapping = new GlideRecord("pa_breakdown_mappings");
        breakdownMapping.addQuery("breakdown", recID);
        breakdownMapping.query();
        while (breakdownMapping.next()) {
            this.saveRecord(breakdownMapping);

            paScriptID = breakdownMapping.getValue("script");
            if (!gs.nil(paScriptID)) {
                this._addPAScript(paScriptID);
            }
        }

        var breakdownRelation = new GlideRecord("pa_breakdown_relations");
        breakdownRelation.addQuery("breakdown", recID);
        breakdownRelation.query();
        while (breakdownRelation.next()) {
            this.saveRecord(breakdownRelation);

            var relatedBreakdownID = breakdownRelation.getValue("related_breakdown");
            if (!gs.nil(relatedBreakdownID)) {
                this._addPABreakdown(relatedBreakdownID);
            }
        }
    },

    _addPATarget: function(targetQuery) {
        var paTarget = new GlideRecord("pa_targets");
        paTarget.addEncodedQuery(targetQuery);
        paTarget.query();
        while (paTarget.next()) {
            this.saveRecord(paTarget);

            if (targetQuery.startsWith("indicator")) {
                if (!gs.nil(paTarget.getValue("breakdown"))) {
                    this._addPABreakdown(paTarget.getValue("breakdown"));
                }
                if (!gs.nil(paTarget.getValue("breakdown_level2"))) {
                    this._addPABreakdown(paTarget.getValue("breakdown_level2"));
                }
            } else if (!gs.nil(paTarget.getValue("indicator"))) {
                this._addPAIndicator(paTarget.getValue("indicator"));
            }

            var targetValue = new GlideRecord("pa_target_values");
            targetValue.addQuery("target", paTarget.getValue("sys_id"));
            targetValue.query();
            while (targetValue.next()) {
                this.saveRecord(targetValue);
            }
        }
    },

    _addPAThreshold: function(thresholdQuery) {
        var paThreshold = new GlideRecord("pa_thresholds");
        paThreshold.addEncodedQuery(thresholdQuery);
        paThreshold.query();
        while (paThreshold.next()) {
            this.saveRecord(paThreshold);

            if (thresholdQuery.startsWith("indicator")) {
                if (!gs.nil(paThreshold.getValue("breakdown"))) {
                    this._addPABreakdown(paThreshold.getValue("breakdown"));
                }
                if (!gs.nil(paThreshold.getValue("breakdown_level2"))) {
                    this._addPABreakdown(paThreshold.getValue("breakdown_level2"));
                }
            } else if (!gs.nil(paThreshold.getValue("indicator"))) {
                this._addPAIndicator(paThreshold.getValue("indicator"));
            }
        }
    },

    _addPAScript: function(paScriptID) {
        var paScript = new GlideRecord("pa_scripts");
        if (paScript.get(paScriptID)) {
            this.saveRecord(paScript);
        }
    },

    _addPAFilter: function(paFilterID) {
        var elementsFilter = new GlideRecord("pa_filters");
        if (elementsFilter.get(paFilterID)) {
            this.saveRecord(elementsFilter);
        }
    },

    //Add report colors
    _addReportColors: function(record) {
        var colorList = [];
        var exclusionFields = [];
        var recordUtil = new GlideRecordUtil();
        var fieldList = recordUtil.getFields(record);

        for (var i = 0; i < fieldList.length; i++) {
            var fieldName = fieldList[i];
            var fieldType = record.getElement(fieldName).getED().getInternalType();
            if (fieldType != "reference" || exclusionFields.indexOf(fieldName) > -1 || record[fieldName].getReferenceTable() != "sys_report_color") {
                continue;
            }

            var fieldValue = record.getValue(fieldName);
            if (!gs.nil(fieldValue) && colorList.indexOf(colorList) == -1) {
                colorList.push(fieldValue);
            }
        }

        var reportColor = new GlideRecord("sys_report_color");
        reportColor.addQuery("sys_id", "IN", colorList.toString());
        reportColor.query();
        while (reportColor.next()) {
            this.saveRecord(reportColor);
        }
    },

    //Add report chart colors
    _addReportChartColors: function(record) {
        if (record.getValue('set_color') == 'chart_colors') {
            var encQuery = "name=" + record.getValue('table') + "^element=" + record.getValue('field');
            var chartColor = new GlideRecord('sys_report_chart_color');
            chartColor.addEncodedQuery(encQuery);
            chartColor.query();
            while (chartColor.next()) {
                this.saveRecord(chartColor);
            }
        }
    },

    //Add interactive filter
    _addInteractiveFilter: function(record, tableName) {
        var recID;
        if (typeof record == "string") {
            recID = record;
            record = new GlideRecord("sys_ui_hp_publisher");
            record.get(recID);
        }
        recID = record.getValue("sys_id");
        this.saveRecord(record);

        //Add cascading filter
        var cascadingFilter = new GlideRecord("sys_ui_hp_cascading_filter");
        cascadingFilter.addQuery("publisher_reference", recID);
        cascadingFilter.query();
        while (cascadingFilter.next()) {
            this._addCascadingFilter(cascadingFilter);
        }

        //Add choice lists - may revisit later as the Exclusion and Default value fields point to sys_choice and no ability to add new ones

        //Add filter reference
        var filterRef = new GlideRecord("sys_ui_hp_reference");
        filterRef.addQuery("publisher_reference", recID);
        filterRef.query();
        while (filterRef.next()) {
            this.saveRecord(filterRef);
        }

        //Add filter date
        var filterDate = new GlideRecord("sys_ui_hp_date");
        filterDate.addQuery("publisher_reference", recID);
        filterDate.query();
        while (filterDate.next()) {
            this.saveRecord(filterDate);
        }

        //Add group & child filters
        var filterGroup = new GlideRecord("sys_ui_hp_group");
        filterGroup.addQuery("group_publisher", recID);
        filterGroup.query();
        while (filterGroup.next()) {
            this.saveRecord(filterGroup);

            var childFilter = new GlideRecord("sys_ui_hp_publisher");
            if (childFilter.get(filterGroup.child_publisher.toString())) {
                this._addInteractiveFilter(childFilter, childFilter.getTableName());
            }
        }
    },

    _addCascadingFilter: function(record, tableName) {
        var recID;
        if (typeof record == "string") {
            recID = record;
            record = new GlideRecord("sys_ui_hp_cascading_filter");
            record.get(recID);
        }
        recID = record.getValue("sys_id");
        this.saveRecord(record);

        //Add cascading filter
        var cascadingFilter = new GlideRecord("sys_ui_hp_cascading_filter");
        cascadingFilter.addQuery("parent", recID);
        cascadingFilter.query();
        while (cascadingFilter.next()) {
            this._addCascadingFilter(cascadingFilter);
        }
    },

    //Add Home Page Static Content to the update set
    _addHPStaticContent: function(staticContentID) {
        var staticContent = new GlideRecord("content_block_static");
        if (staticContent.get(staticContentID)) {
            this.saveRecord(staticContent);
        }
    },

    //Add Home Page Gauge and contents to the update set
    _addHPGauge: function(sysGaugeID) {
        var sysGauge = new GlideRecord("sys_gauge");
        if (sysGauge.get(sysGaugeID)) {
            this.saveRecord(sysGauge);

            if (sysGauge.getValue("type") == "report") {
                this._addReport(sysGauge.getValue("report"));
            }
        }
    },

    /********************* End Reporting and PA Functions *********************/

    //Add assessment to the update set
    _addAssessment: function(tableRec, tableName) {
        this.saveRecord(tableRec);

        // Check for auto-generated business rules
        var businessRuleIDs = [];
        var businessRuleID = tableRec.getValue("business_rule");
        if (!gs.nil(businessRuleID)) {
            businessRuleIDs.push(businessRuleID);
        }
        businessRuleID = tableRec.getValue("delete_business_rule");
        if (!gs.nil(businessRuleID)) {
            businessRuleIDs.push(businessRuleID);
        }
        var businessRule = new GlideRecord("sys_script");
        businessRule.addQuery("sys_id", "IN", businessRuleIDs.toString());
        businessRule.query();
        while (businessRule.next()) {
            this.saveRecord(businessRule);
        }

        var assessmentID = tableRec.getValue("sys_id");

        var assessmentCategory = new GlideRecord("asmt_metric_category");
        assessmentCategory.addQuery("metric_type", assessmentID);
        assessmentCategory.query();
        while (assessmentCategory.next()) {
            this.saveRecord(assessmentCategory);

            var assessmentQuestion = new GlideRecord("asmt_metric");
            assessmentQuestion.addQuery("category", assessmentCategory.getValue("sys_id"));
            assessmentQuestion.query();
            while (assessmentQuestion.next()) {
                this.saveRecord(assessmentQuestion);

                var assessmentQuestionID = assessmentQuestion.getValue("sys_id");

                var assessmentTemplate = assessmentQuestion.template.getRefRecord();
                this.saveRecord(assessmentTemplate);

                var assessmentTemplateDefinition = new GlideRecord("asmt_template_definition");
                assessmentTemplateDefinition.addQuery("template", assessmentQuestionID);
                assessmentTemplateDefinition.query();
                while (assessmentTemplateDefinition.next()) {
                    this.saveRecord(assessmentTemplateDefinition);
                }

                var assessmentDefinition = new GlideRecord("asmt_metric_definition");
                assessmentDefinition.addQuery();
                assessmentDefinition.query("metric", assessmentQuestionID);
                while (assessmentDefinition.next()) {
                    this.saveRecord(assessmentDefinition);
                }
            }
        }

        var assessmentCondition = new GlideRecord("asmt_condition");
        assessmentCondition.addQuery("assessment", assessmentID);
        assessmentCondition.query();
        while (assessmentCondition.next()) {
            this.saveRecord(assessmentCondition);

            businessRule = assessmentCondition.business_rule.getRefRecord();
            this.saveRecord(businessRule);
        }
    },

    //Add Virtual Agent to the update set
    _addVirtualAgent: function(tableRec, tableName) {
        this.saveRecord(tableRec);

        var otherTable = "";
        var queryField = "";
        var queryValue = "";
        var csTopicID = "";
        var cbTopicID = "";
        if (tableName == "sys_cs_topic") {
            csTopicID = tableRec.getValue("sys_id");
            cbTopicID = tableRec.getValue("cb_topic_id");
            otherTable = "sys_cb_topic";
            queryField = "sys_id";
            queryValue = cbTopicID;
        } else {
            cbTopicID = tableRec.getValue("sys_id");
            otherTable = "sys_cs_topic";
            queryField = "cb_topic_id";
            queryValue = cbTopicID;
        }

        var agentTopic = new GlideRecord(otherTable);
        agentTopic.addQuery(queryField, queryValue);
        agentTopic.query();
        if (agentTopic.next()) {
            this.saveRecord(agentTopic);
        } else {
            agentTopic.initialize();
            agentTopic.addQuery("name", tableRec.getValue("name"));
            agentTopic.query();
            if (agentTopic.next()) {
                this.saveRecord(agentTopic);
            }
        }

        if (csTopicID == "" && otherTable == "sys_cs_topic") {
            csTopicID = agentTopic.getValue("sys_id");
        }

        //Add Design Topic
        if (!gs.nil(csTopicID) && !gs.nil(cbTopicID)) {
            var cbDesignTopic = new GlideRecord("sys_cb_design_topic");
            cbDesignTopic.query("compiled_topic", csTopicID);
            cbDesignTopic.query("design_topic_id", cbTopicID);
            cbDesignTopic.query();
            if (cbDesignTopic.next()) {
                this.saveRecord(cbDesignTopic);
            }
        }

        //Add Topic Variables
        var topicVariable = new GlideRecord("topic_variable");
        topicVariable.query("model", cbTopicID);
        topicVariable.query();
        while (topicVariable.next()) {
            this.saveRecord(topicVariable);
        }

        //Add Field Labal
        var sysDocumentation = new GlideRecord("sys_documentation");
        sysDocumentation.addQuery("name", "CONTAINS", cbTopicID);
        sysDocumentation.query();
        while (sysDocumentation.next()) {
            this.saveRecord(sysDocumentation);
        }

        //Add NLU Model if set
        var hasNLUModel = false;
        var nluModelID = "";
        if (tableRec.isValidField("nlu_model")) {
            nluModelID = tableRec.getValue("nlu_model");
            if (!gs.nil(nluModelID)) {
                hasNLUModel = true;
            }
        }

        if (hasNLUModel) {
            this._addNLUModel(nluModelID);
        }
    },

    _addNLUModel: function(NLUModel, tableName) {
        var recID;
        if (typeof NLUModel == "string") {
            recID = NLUModel;
            NLUModel = new GlideRecord("sys_nlu_model");
            NLUModel.get("name", recID);
        }

        // Check if NLU Model has Protection Policy set and if so, abort adding it since that should be part of Plugin or Store App
        if (this.preventProtectedNLUModels && !gs.nil(NLUModel.getValue("sys_policy"))) {
            var warningMessages = this.clientSession.getClientData("warningMessages") + "";
            // split adding an extra comma so checking length
            if (warningMessages.length == 0) {
                warningMessages = [];
            } else {
                warningMessages = warningMessages.split(",");
            }
            var warningMessage = '<a href="' + NLUModel.getLink() + '" target="_blank">' + NLUModel.getDisplayValue() + '</a> ' + NLUModel.getClassDisplayValue();
            warningMessage = warningMessage + " could not be added to the update set because of its protection policy.";
            if (warningMessages.indexOf(warningMessage) == -1) {
                warningMessages.push(warningMessage);
            }
            this.clientSession.putClientData("warningMessages", warningMessages.toString());

            return;
        }

        this.saveRecord(NLUModel);
        recID = NLUModel.getValue("sys_id");

        var intentList = [];
        var NLUIntent = new GlideRecord("sys_nlu_intent");
        NLUIntent.addQuery("model", recID);
        NLUIntent.query();
        while (NLUIntent.next()) {
            this.saveRecord(NLUIntent);
            intentList.push(NLUIntent.getValue("sys_id"));
        }

        var NLUUtterance = new GlideRecord("sys_nlu_utterance");
        NLUUtterance.addQuery("intent", "IN", intentList.toString());
        NLUUtterance.query();
        while (NLUUtterance.next()) {
            this.saveRecord(NLUUtterance);
        }

        var entityList = [];
        var intentEntityM2M = new GlideRecord("m2m_sys_nlu_intent_entity");
        intentEntityM2M.addQuery("intent", "IN", intentList.toString());
        intentEntityM2M.query();
        while (intentEntityM2M.next()) {
            this.saveRecord(intentEntityM2M);
            entityList.push(intentEntityM2M.getValue("entity"));
        }

        var NLUEntity = new GlideRecord("sys_nlu_entity");
        NLUEntity.addQuery("sys_id", "IN", entityList.toString()).addOrCondition("model", recID);
        NLUEntity.query();
        while (NLUEntity.next()) {
            this.saveRecord(NLUEntity);
        }

        var NLUVocabulary = new GlideRecord("sys_nlu_vocabulary");
        NLUVocabulary.addQuery("model", recID);
        NLUVocabulary.query();
        while (NLUVocabulary.next()) {
            this.saveRecord(NLUVocabulary);
        }

        var systemEntityM2M = new GlideRecord("m2m_sys_nlu_model_sys_entity");
        systemEntityM2M.addQuery("model", recID);
        systemEntityM2M.query();
        while (systemEntityM2M.next()) {
            this.saveRecord(systemEntityM2M);
            var systemEntity = new GlideRecord("sys_nlu_sys_entity");
            systemEntity.addQuery("sys_id", systemEntityM2M.getValue("sys_entity"));
            systemEntity.query();
            while (systemEntity.next()) {
                this.saveRecord(systemEntity);
            }
        }

        /*
         * When moving NLU models from one instance to another, they are loaded in unpublished even though they may have been published in the source instance.
         * The below code will check the status of the NLU model in the source instance and if it is published it will add a scheduled job to the update set
         * to automatically publish the model in the target instance.
         * 
         * This solution is a two pronged approach because of the fact that when the instance is loading the update set, we cannot control the order in which the 
         * updates are loaded.  This scheduled job will run soon after the update set is loaded but will create another scheduled job that will run 60 seconds
         * after that to publish the NLU model.  60 seconds should be enough time to load the update set components but feel free to adjust the delaySeconds variable value.
         */

        if (NLUModel.getValue("state") == "Published") {
            var delaySeconds = 60;
            var scheduledJobName = NLUModel.getValue("display_name") + ": Train and Publish";

            var scheduledJobScript = [];
            scheduledJobScript.push("var scheduledJob = new GlideRecord('sys_trigger')");
            scheduledJobScript.push("scheduledJob.name = '" + scheduledJobName + "'");
            scheduledJobScript.push("scheduledJob.trigger_type = 0");
            scheduledJobScript.push("var nextAction = new GlideDateTime()");
            scheduledJobScript.push("nextAction.addSeconds(" + delaySeconds + ")");
            scheduledJobScript.push("scheduledJob.next_action = nextAction");
            var targetScript = [];
            targetScript.push("var nluID = '" + recID + "'");
            targetScript.push("new global.NLUStudioUtil().trainModel(nluID)");
            targetScript.push("new global.NLUStudioUtil().publishModel(nluID)");
            targetScript = targetScript.join(";").replace(/'/g, "\\'");
            scheduledJobScript.push("scheduledJob.script = '" + targetScript + ";'");
            scheduledJobScript.push("scheduledJob.insert()");

            var scheduleJobFields = {};
            scheduleJobFields.name = scheduledJobName;
            var nowDateTime = new GlideDateTime();
            scheduleJobFields.next_action = nowDateTime.getDisplayValue();
            scheduleJobFields.trigger_type = "0";
            scheduleJobFields.script = scheduledJobScript.join(";") + ";";
            this.addScheduledJob(scheduleJobFields);
        }
    },

    _addManagedDoc: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var managedDocID = tableRec.getValue("sys_id");

        var docRevision = new GlideRecord("dms_document_revision");
        docRevision.addQuery("document", managedDocID);
        docRevision.query();
        while (docRevision.next()) {
            this.saveRecord(docRevision);

            // Check to ensure Human Resources Core plugin is active
            if (new GlidePluginManager().isActive("com.sn_hr_core")) {
                try {
                    //Add HR PDF Template
                    new sn_hr_core.addToUpdateSetUtils()._getHRDocumentTemplates(docRevision.getValue("sys_id"));
                } catch (err) {

                }
            }
        }

        var userPermission = new GlideRecord("dms_document_user_permission");
        userPermission.addQuery("document", managedDocID);
        userPermission.query();
        while (userPermission.next()) {
            this.saveRecord(userPermission);
        }

        var groupPermission = new GlideRecord("dms_document_group_permission");
        groupPermission.addQuery("document", managedDocID);
        groupPermission.query();
        while (groupPermission.next()) {
            this.saveRecord(groupPermission);
        }

        var knowledgeRecordM2M = new GlideRecord("m2m_document_knowledge");
        knowledgeRecordM2M.addQuery("document", managedDocID);
        knowledgeRecordM2M.query();
        while (knowledgeRecordM2M.next()) {
            this.saveRecord(knowledgeRecordM2M);

            var kbKnowledge = new GlideRecord("kb_knowledge");
            if (kbKnowledge.get(knowledgeRecordM2M.getValue("knowledge"))) {
                this._addKnowledge(kbKnowledge, knowledgeRecordM2M.getValue("knowledge_table_name"));
            }
        }
    },

    _addATF: function(atfTest, tableName) {
        this.saveRecord(atfTest);
        var testID = atfTest.getValue("sys_id");

        var stepConfigList = [];
        var testStep = new GlideRecord("sys_atf_step");
        testStep.addQuery("test", testID);
        testStep.query();
        while (testStep.next()) {
            this.saveRecord(testStep);

            //Check to see if linked test step config is protected and if not add it
            if (gs.nil((testStep.step_config.sys_policy.toString()))) {
                stepConfigList.push(testStep.getValue("step_config"));
            }
        }

        if (stepConfigList.length > 0) {
            var testStepConfig = new GlideRecord("sys_atf_step_config");
            testStepConfig.addQuery("sys_id", "IN", stepConfigList.toString());
            testStepConfig.query();
            while (testStepConfig.next()) {
                this.saveRecord(testStepConfig);
                var testStepConfigID = testStepConfig.getValue("sys_id");

                var inputVariable = new GlideRecord("atf_input_variable");
                inputVariable.addQuery("model", testStepConfigID);
                inputVariable.query();
                while (inputVariable.next()) {
                    this.saveRecord(inputVariable);
                }

                var outputVariable = new GlideRecord("atf_output_variable");
                outputVariable.addQuery("model", testStepConfigID);
                outputVariable.query();
                while (outputVariable.next()) {
                    this.saveRecord(outputVariable);
                }
            }
        }

        var testRunDataSet = new GlideRecord("sys_atf_parameter_set");
        testRunDataSet.addQuery("test", testID);
        testRunDataSet.query();
        while (testRunDataSet.next()) {
            this.saveRecord(testRunDataSet);
        }

        var dictionaryQuery = "name=sys_atf_parameter_set^element!=active^element!=description^element!=order^element!=parameters^element!=sys_id^element!=test^element!=copied_from";
        var sysDictionary = new GlideRecord("sys_dictionary");
        sysDictionary.addEncodedQuery(dictionaryQuery);
        sysDictionary.query();
        if (sysDictionary.hasNext()) {
            while (sysDictionary.next()) {
                this._addField(sysDictionary, "sys_dictionary");
            }

            // Add Test Run Data Set Form since it was modified when adding sys_dictionary records
            var uiFormSection = new GlideRecord("sys_ui_section");
            uiFormSection.addQuery("name", "sys_atf_parameter_set");
            uiFormSection.query();
            while (uiFormSection.next()) {
                this.saveRecord(uiFormSection);
            }
        }

        var parameterVariable = new GlideRecord("sys_atf_parameter_variable");
        parameterVariable.addQuery("model", testID);
        parameterVariable.query();
        while (parameterVariable.next()) {
            this._addField(parameterVariable, "sys_atf_parameter_variable");
        }

    },

    //Add guided tour and dependencies to the update set
    _addGuidedTour: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var recID = tableRec.getValue("sys_id");

        var actionTargetRefList = [];
        var guidedTourStep = new GlideRecord("sys_embedded_tour_step");
        guidedTourStep.addQuery("guide", recID);
        guidedTourStep.query();
        while (guidedTourStep.next()) {
            this.saveRecord(guidedTourStep);

            var actionTargetRefID = guidedTourStep.getValue("action_target_ref");
            if (!gs.nil(actionTargetRefID)) {
                actionTargetRefList.push(actionTargetRefID);
            }
        }

        if (actionTargetRefList.length > 0) {
            var guidedTourElement = new GlideRecord("sys_embedded_tour_element");
            guidedTourElement.addQuery("sys_id", "IN", actionTargetRefList.toString());
            guidedTourElement.query();
            while (guidedTourElement.next()) {
                this.saveRecord(guidedTourElement);
            }
        }
    },

    /********************* Begin Service Portal Functions *********************/
    _addSPPortal: function(record, tableName) {
        this.saveRecord(record);

        var portalPage;
        //Add homepage
        if (!record.homepage.nil()) {
            portalPage = new GlideRecord("sp_page");
            if (portalPage.get(record.homepage.sys_id.toString())) {
                this.saveRecord(portalPage);
                this._addPageDependencies(portalPage);
            }
        }
        //Add KB homepage
        if (!record.kb_knowledge_page.nil()) {
            portalPage = new GlideRecord("sp_page");
            if (portalPage.get(record.kb_knowledge_page.sys_id.toString())) {
                this.saveRecord(portalPage);
                this._addPageDependencies(portalPage);
            }
        }
        //Add Login page
        if (!record.login_page.nil()) {
            portalPage = new GlideRecord("sp_page");
            if (portalPage.get(record.login_page.sys_id.toString())) {
                this.saveRecord(portalPage);
                this._addPageDependencies(portalPage);
            }
        }
        //Add 404 page
        if (!record.notfound_page.nil()) {
            portalPage = new GlideRecord("sp_page");
            if (portalPage.get(record.notfound_page.sys_id.toString())) {
                this.saveRecord(portalPage);
                this._addPageDependencies(portalPage);
            }
        }
        //Add Catalog page
        if (!record.sc_catalog_page.nil()) {
            portalPage = new GlideRecord("sp_page");
            if (portalPage.get(record.sc_catalog_page.sys_id.toString())) {
                this.saveRecord(portalPage);
                this._addPageDependencies(portalPage);
            }
        }
        //Add Main Menu
        if (!record.sp_rectangle_menu.nil()) {
            var mainMenu = new GlideRecord("sp_instance_menu");
            if (mainMenu.get(record.sp_rectangle_menu.sys_id.toString())) {
                //Add Menu rectangle items
                var menuRectangleItem = new GlideRecord("sp_rectangle_menu_item");
                menuRectangleItem.addQuery("sp_rectangle_menu", mainMenu.sys_id.toString());
                menuRectangleItem.query();
                while (menuRectangleItem.next()) {
                    this.saveRecord(menuRectangleItem);
                    this._gatherChildMenuRectangleItems(menuRectangleItem);
                }
                this.saveRecord(mainMenu);
            }
        }
        //Add Theme
        if (!record.theme.nil()) {
            var theme = new GlideRecord("sp_theme");
            if (theme.get(record.theme.sys_id.toString())) {
                //Add header &amp; footer
                var headerFooter = new GlideRecord("sp_header_footer");
                headerFooter.addQuery("sys_id", theme.header.sys_id.toString()).addOrCondition("sys_id", theme.footer.sys_id.toString());
                headerFooter.query();
                while (headerFooter.next()) {
                    //Add ng-templates
                    var ngTemplate = new GlideRecord("sp_ng_template");
                    ngTemplate.addQuery("sp_widget", headerFooter.sys_id.toString());
                    ngTemplate.query();
                    while (ngTemplate.next())
                        this.saveRecord(ngTemplate);
                    this.saveRecord(headerFooter);
                }
                //Add JS Includes
                var jsIncludeM2M = new GlideRecord("m2m_sp_theme_js_include");
                jsIncludeM2M.addQuery("sp_theme", theme.sys_id.toString());
                jsIncludeM2M.query();
                while (jsIncludeM2M.next()) {
                    var jsInclude = new GlideRecord("sp_js_include");
                    if (jsInclude.get(jsIncludeM2M.sp_js_include.sys_id.toString())) {
                        //For local js includes, get ui script
                        if (jsInclude.source.toString() == 'local') {
                            var uiScript = new GlideRecord("sys_ui_script");
                            if (uiScript.get(jsInclude.sys_ui_script.sys_id.toString()))
                                this.saveRecord(uiScript);
                        }
                        this.saveRecord(jsInclude);
                    }
                    this.saveRecord(jsIncludeM2M);
                }
                //Add CSS Includes
                var cssIncludeM2M = new GlideRecord("m2m_sp_theme_css_include");
                cssIncludeM2M.addQuery("sp_theme", theme.sys_id.toString());
                cssIncludeM2M.query();
                while (cssIncludeM2M.next()) {
                    var cssInclude = new GlideRecord("sp_css_include");
                    if (cssInclude.get(cssIncludeM2M.sp_css_include.sys_id.toString())) {
                        //For local css includes, get style sheet
                        if (cssInclude.source.toString() == 'local') {
                            var styleSheet = new GlideRecord("sp_css");
                            if (styleSheet.get(cssInclude.sp_css.sys_id.toString()))
                                this.saveRecord(styleSheet);
                        }
                        this.saveRecord(cssInclude);
                    }
                    this.saveRecord(cssIncludeM2M);
                }
                this.saveRecord(theme);
            }
        }
        //Add Search Sources		
        var searchSourceList = [];
        var searchSourceM2M = new GlideRecord("m2m_sp_portal_search_source");
        searchSourceM2M.addQuery("sp_portal", record.sys_id.toString());
        searchSourceM2M.query();
        while (searchSourceM2M.next()) {
            this.saveRecord(searchSourceM2M);
            searchSourceList.push(searchSourceM2M.sp_search_source.toString());
        }
        if (searchSourceList.length > 0)
            this._addSearchSources(searchSourceList);
    },

    _addSearchSources: function(recordIDs) {
        var searchSource = new GlideRecord("sp_search_source");
        searchSource.addQuery("sys_id", "IN", recordIDs.toString());
        searchSource.query();
        while (searchSource.next()) {
            this.saveRecord(searchSource);
        }
    },

    _addSPWidget: function(record, tableName) {
        this.saveRecord(record);
        this._addWidgetDependencies(record);
    },

    _addSPPage: function(record, tableName) {
        this.saveRecord(record);
        this._addPageDependencies(record);
    },

    //Add page dependencies to the update set
    _addPageDependencies: function(record) {
        //Add containers
        var container = new GlideRecord("sp_container");
        container.addQuery("sp_page", record.sys_id.toString());
        container.query();
        while (container.next()) {
            //Add rows
            var row = new GlideRecord("sp_row");
            row.addQuery("sp_container", container.sys_id.toString());
            row.query();
            while (row.next()) {
                //add columns and column rows and widget instances
                this._gatherColumnsAndColumnRowsAndInstances(row);
                this.saveRecord(row);
            }
            this.saveRecord(container);
        }
        //Add menu rectangle items
        var menuRectangleItem = new GlideRecord("sp_rectangle_menu_item");
        menuRectangleItem.addQuery("sp_page", record.sys_id.toString());
        menuRectangleItem.query();
        while (menuRectangleItem.next()) {
            this.saveRecord(menuRectangleItem);
            this._gatherChildMenuRectangleItems(menuRectangleItem);
        }

        this._gatherSPUserCriteria("sp_page", record.sys_id.toString());

        try {
            //Add content delivery items
            new sn_cd.addToUpdateSetUtils().checkScheduledContent(record.sys_id.toString());
        } catch (err) {

        }
    },

    //Add widget dependencies to the update set
    _addWidgetDependencies: function(record) {
        //Add dependencies
        var dependencyM2M = new GlideRecord("m2m_sp_widget_dependency");
        dependencyM2M.addQuery("sp_widget", record.sys_id.toString());
        dependencyM2M.query();
        while (dependencyM2M.next()) {
            var dependency = new GlideRecord("sp_dependency");
            if (dependency.get(dependencyM2M.sp_dependency.sys_id.toString())) {
                //Add JS Includes
                var jsIncludeM2M = new GlideRecord("m2m_sp_dependency_js_include");
                jsIncludeM2M.addQuery("sp_dependency", dependency.sys_id.toString());
                jsIncludeM2M.query();
                while (jsIncludeM2M.next()) {
                    var jsInclude = new GlideRecord("sp_js_include");
                    if (jsInclude.get(jsIncludeM2M.sp_js_include.sys_id.toString())) {
                        //For local js includes, get ui script
                        if (jsInclude.source.toString() == 'local') {
                            var uiScript = new GlideRecord("sys_ui_script");
                            if (uiScript.get(jsInclude.sys_ui_script.sys_id.toString()))
                                this.saveRecord(uiScript);
                        }
                        this.saveRecord(jsInclude);
                    }
                    this.saveRecord(jsIncludeM2M);
                }
                //Add CSS Includes
                var cssIncludeM2M = new GlideRecord("m2m_sp_dependency_css_include");
                cssIncludeM2M.addQuery("sp_dependency", dependency.sys_id.toString());
                cssIncludeM2M.query();
                while (cssIncludeM2M.next()) {
                    var cssInclude = new GlideRecord("sp_css_include");
                    if (cssInclude.get(cssIncludeM2M.sp_css_include.sys_id.toString())) {
                        //For local css includes, get style sheet
                        if (cssInclude.source.toString() == 'local') {
                            var styleSheet = new GlideRecord("sp_css");
                            if (styleSheet.get(cssInclude.sp_css.sys_id.toString()))
                                this.saveRecord(styleSheet);
                        }
                        this.saveRecord(cssInclude);
                    }
                    this.saveRecord(cssIncludeM2M);
                }
                this.saveRecord(dependency);
            }
            this.saveRecord(dependencyM2M);
        }
        //Add angular providers
        var providerM2M = new GlideRecord("m2m_sp_ng_pro_sp_widget");
        providerM2M.addQuery("sp_widget", record.sys_id.toString());
        providerM2M.query();
        while (providerM2M.next()) {
            var provider = new GlideRecord("sp_angular_provider");
            if (provider.get(providerM2M.sp_angular_provider.sys_id.toString())) {
                //Get required providers
                this._gatherRequiredProviders(provider);
                this._addAngularProvider(provider, provider.getTableName());
            }
            this.saveRecord(providerM2M);
        }
        //Add ng-templates
        var ngTemplate = new GlideRecord("sp_ng_template");
        ngTemplate.addQuery("sp_widget", record.sys_id.toString());
        ngTemplate.query();
        while (ngTemplate.next()) {
            this._addNgTemplate(ngTemplate, ngTemplate.getTableName());
        }
        //Add embedded widgets
        this._addEmbeddedWidgets(record.template.toString());

        //Gather custom data table
        var systemDataTables = [
            'sp_instance',
            'sp_instance_carousel',
            'sp_instance_link',
            'sp_instance_menu',
            'sp_instance_table',
            'sp_instance_vlist'
        ];
        var widgetDataTable = record.data_table.toString();
        var isSystem = false;
        for (var i = 0; i < systemDataTables.length; i++) {
            if (systemDataTables[i] == widgetDataTable) {
                isSystem = true;
                break;
            }
        }
        if (!isSystem) {
            var dbObjRec = new GlideRecord('sys_db_object');
            dbObjRec.addQuery('name', widgetDataTable);
            dbObjRec.query();
            if (dbObjRec.next())
                this._addDbObject(dbObjRec, widgetDataTable);
        }

        this._gatherSPUserCriteria("sp_widget", record.sys_id.toString());
    },

    //Add Angular Provider
    _addAngularProvider: function(record, tableName) {
        this.saveRecord(record);

        this._addEmbeddedWidgets(record.script.toString());
    },

    //Add NG Template
    _addNgTemplate: function(record, tableName) {
        this.saveRecord(record);

        this._addEmbeddedWidgets(record.template.toString());
    },

    //Add Embedded Widgets from a script or template
    _addEmbeddedWidgets: function(template) {
        return;
        /* Disabling until we can find a more effective method for this */
        /* 
		var regExp = new RegExp('&lt;sp-widget.*id=["\'](.*)["\']', 'g');
        var widgetId = regExp.exec(template);
        while (widgetId) {
            var embeddedWidget = new GlideRecord("sp_widget");
            embeddedWidget.addQuery("id", widgetId[1]);
            embeddedWidget.query();
            if (embeddedWidget.next()) {
                this.saveRecord(embeddedWidget);
                this._addWidgetDependencies(embeddedWidget);
            }
            widgetId = regExp.exec(template);
		}
		*/
    },

    //Recursively gather all required angular providers
    _gatherRequiredProviders: function(provider) {
        var requiredProviderM2M = new GlideRecord("m2m_sp_ng_pro_sp_ng_pro");
        requiredProviderM2M.addQuery("required_by", provider.sys_id.toString());
        requiredProviderM2M.query();
        while (requiredProviderM2M.next()) {
            var requiredProvider = new GlideRecord("sp_angular_provider");
            if (requiredProvider.get(requiredProviderM2M.requires.sys_id.toString())) {
                this.saveRecord(requiredProvider);
                this._gatherRequiredProviders(requiredProvider);
            }
            this.saveRecord(requiredProviderM2M);
        }
        return;
    },

    //Recursively gather all columns and column rows
    _gatherColumnsAndColumnRowsAndInstances: function(row) {
        //add columns
        var column = new GlideRecord("sp_column");
        column.addQuery("sp_row", row.sys_id.toString());
        column.query();
        while (column.next()) {
            //Add widget instances
            var widgetInstance = new GlideRecord("sp_instance");
            widgetInstance.addQuery("sp_column", column.sys_id.toString());
            widgetInstance.query();
            while (widgetInstance.next()) {
                //Add widget
                var widget = new GlideRecord("sp_widget");
                if (widget.get(widgetInstance.sp_widget.sys_id.toString())) {
                    this.saveRecord(widget);
                    this._addWidgetDependencies(widget);
                }
                this.saveRecord(widgetInstance);

                this._gatherSPUserCriteria("sp_instance", widgetInstance.sys_id.toString());
            }
            //Add column rows
            var columnRow = new GlideRecord("sp_row");
            columnRow.addQuery("sp_column", column.sys_id.toString());
            columnRow.query();
            while (columnRow.next()) {
                this.saveRecord(columnRow);
                this._gatherColumnsAndColumnRowsAndInstances(columnRow);
            }
            this.saveRecord(column);
        }
        return;
    },

    //Recursively gather all child menu rectangle items
    _gatherChildMenuRectangleItems: function(menuRectangleItem) {
        var childMenuRectangleItem = new GlideRecord("sp_rectangle_menu_item");
        childMenuRectangleItem.addQuery("sp_rectangle_menu_item", menuRectangleItem.sys_id.toString());
        childMenuRectangleItem.query();
        while (childMenuRectangleItem.next()) {
            this.saveRecord(childMenuRectangleItem);
            this._gatherChildMenuRectangleItems(childMenuRectangleItem);
        }
    },

    //Recursively gather all user criteria
    _gatherSPUserCriteria: function(tableName, recID) {
        if (new GlidePluginManager().isActive("com.glide.service-portal.user-criteria")) {
            //Add user criteria
            var availableForList = [];
            var availableForTableName = "m2m_" + tableName + "_uc_can_view";
            var availableForM2M = new GlideRecord(availableForTableName);
            availableForM2M.addQuery(tableName, recID);
            availableForM2M.query();
            while (availableForM2M.next()) {
                this.saveRecord(availableForM2M);
                availableForList.push(availableForM2M.getValue("user_criteria"));
            }

            var notAvailableForList = [];
            var notAvailableForTableName = "m2m_" + tableName + "_uc_cannot_view";
            var notAvailableForM2M = new GlideRecord(notAvailableForTableName);
            notAvailableForM2M.addQuery(tableName, recID);
            notAvailableForM2M.query();
            while (notAvailableForM2M.next()) {
                this.saveRecord(notAvailableForM2M);
                notAvailableForList.push(notAvailableForM2M.getValue("user_criteria"));
            }

            this._addUserCriteria(availableForList, notAvailableForList);
        }
    },

    /********************* End Service Portal Functions *********************/

    /********************* Begin Table & Dictionary Functions *********************/
    //Add DB Object to the update set
    _addDbObject: function(record, tableName) {
        this._addTableDependencies(record);
    },

    //Add field to the update
    _addField: function(record, tableName) {
        //If current record is a 'collection' (table), add all table dependencies
        if (record.internal_type.name.toString() == 'collection') {
            this._addTableDependencies(record.name.toString());
        } else {
            this.saveRecord(record);
            this._addFieldDependencies(record, tableName);
        }
    },

    //Add table dependencies to the update set
    _addTableDependencies: function(tableName) {
        //If tableName isn't provided bail since all logic below is dependant on this value
        if (gs.nil(tableName)) {
            return;
        }

        if (typeof tableName == "string") {
            //Add table record
            var dbObject = new GlideRecord("sys_db_object");
            dbObject.addQuery("name", tableName);
            dbObject.query();
            if (dbObject.next()) {
                this.saveRecord(dbObject);
            }
        } else if (typeof tableName == "object" && tableName.getTableName() == "sys_db_object") {
            this.saveRecord(tableName);
            tableName = tableName.name.toString();
        } else {
            return;
        }

        //Add number record
        var sysNumber = new GlideRecord("sys_number");
        sysNumber.addQuery("category", tableName);
        sysNumber.query();
        if (sysNumber.next()) {
            this.saveRecord(sysNumber);

            /*var numberCounter = new GlideRecord("sys_number_counter");
            numberCounter.addQuery("table", tableName);
            numberCounter.query();
            if (numberCounter.next()) {
            	this.saveRecord(numberCounter);
            }*/
        }

        //Add table fields
        var tableField = new GlideRecord("sys_dictionary");
        tableField.addQuery("name", tableName);
        tableField.addQuery("element", "DOES NOT CONTAIN", "sys_").addOrCondition("element", null);
        tableField.query();
        while (tableField.next()) {
            //Process table field
            this.saveRecord(tableField);
            //Process table field dependencies
            this._addFieldDependencies(tableField);
        }
        //Add form & list elements
        this._addFormDependencies(null, tableName);
        //Add choices (redundant for non-extended fields)
        var choice = new GlideRecord("sys_choice");
        choice.addQuery("name", tableName);
        choice.query();
        while (choice.next())
            this.saveRecord(choice);
        //Add dictionary overrides (redundant for non-extended fields)
        var override = new GlideRecord("sys_dictionary_override");
        override.addQuery("name", tableName);
        override.query();
        while (override.next())
            this.saveRecord(override);
        //Add labels (redundant for non-extended fields)
        var label = new GlideRecord("sys_documentation");
        label.addQuery("name", tableName);
        label.addQuery("element", "DOES NOT CONTAIN", "sys_");
        label.query();
        while (label.next())
            this.saveRecord(label);
        //Add field styles
        var fieldStyle = new GlideRecord("sys_ui_style");
        fieldStyle.addQuery("name", tableName);
        fieldStyle.query();
        while (fieldStyle.next())
            this.saveRecord(fieldStyle);
        //Add access controls, access roles, & roles (redundant for non-extended fields)
        this._addACLDependencies(tableName);

        //Add client scripts
        var clientScript = new GlideRecord("sys_script_client");
        clientScript.addQuery("table", tableName);
        clientScript.query();
        while (clientScript.next())
            this.saveRecord(clientScript);
        //Add business rules
        var businessRule = new GlideRecord("sys_script");
        businessRule.addQuery("collection", tableName);
        businessRule.query();
        while (businessRule.next())
            this.saveRecord(businessRule);
        //Add ui actions
        var uiAction = new GlideRecord("sys_ui_action");
        uiAction.addQuery("table", tableName);
        uiAction.query();
        while (uiAction.next()) {
            this.saveRecord(uiAction);
            var actionRole = new GlideRecord("sys_ui_action_role");
            actionRole.addQuery("sys_ui_action", uiAction.sys_id.toString());
            actionRole.query();
            while (actionRole.next()) {
                var role2 = new GlideRecord("sys_user_role");
                if (role2.get(actionRole.sys_user_role.toString()))
                    this.saveRecord(role2);
                this.saveRecord(actionRole);
            }
        }
        //Add ui policies
        this._addUIPolicyDependencies(tableName);
        //Add data policies
        this._addDataPolicyDependencies(tableName);
        //Add modules and applications (New Record & List of Records only)		
        var navModule = new GlideRecord("sys_app_module");
        navModule.addQuery("name", tableName);
        navModule.addQuery("link_type", "IN", "NEW,LIST");
        navModule.query();
        while (navModule.next()) {
            var navApplication = new GlideRecord("sys_app_application");
            if (navApplication.get(navModule.application.toString()))
                this.saveRecord(navApplication);
            this.saveRecord(navModule);
        }

        //Check to see if table is a M2M and if so add that record
        var sysM2M = new GlideRecord("sys_m2m");
        sysM2M.addQuery("m2m_table", tableName);
        sysM2M.query();
        if (sysM2M.next()) {
            this.saveRecord(sysM2M);
        }

        //Check to see if table is an import set and if so add transform maps and dependencies
        if (this._getTableBase(tableName) == "sys_import_set_row") {
            var transformMap = new GlideRecord("sys_transform_map");
            transformMap.addQuery("source_table", tableName);
            transformMap.query();
            while (transformMap.next()) {
                this._addTransformMap(transformMap, "sys_transform_map");
            }
        }
    },

    //Add form dependencies to the update set
    _addFormDependencies: function(record, tableName) {
        if (tableName == "sys_ui_form" && !gs.nil(record)) {
            tableName = record.getValue("name");
        }

        //Add ui sections & elements
        var uiSectionList = [];
        var uiSection = new GlideRecord("sys_ui_section");
        uiSection.addQuery("name", tableName);
        //uiSection.addQuery("view","Default view");
        uiSection.query();
        while (uiSection.next()) {
            this.saveRecord(uiSection);
            uiSectionList.push(uiSection.getValue("sys_id"));
        }
        //Add form & elements
        var formViewList = [];
        var formView = new GlideRecord("sys_ui_form");
        formView.addQuery("name", tableName);
        //formView.addQuery("view","Default view");
        formView.query();
        while (formView.next()) {
            this.saveRecord(formView);
            formViewList.push(formView.getValue("sys_id"));
        }
        //Add form sections
        var formSectionQuery = "sys_ui_formIN" + formViewList.toString();
        formSectionQuery = formSectionQuery + "^ORsys_ui_sectionIN" + uiSectionList.toString();
        var formSection = new GlideRecord("sys_ui_form_section");
        formSection.addEncodedQuery(formSectionQuery);
        formSection.query();
        while (formSection.next()) {
            this.saveRecord(formSection);
        }
        //Add list views
        var listView = new GlideRecord("sys_ui_list");
        listView.addQuery("name", tableName);
        //listView.addQuery("view", "Default view");
        listView.query();
        while (listView.next())
            this.saveRecord(listView);
        //Add related lists
        var relatedList = new GlideRecord("sys_ui_related_list");
        relatedList.addQuery("name", tableName);
        //relatedList.addQuery("view", "Default view");
        relatedList.query();
        while (relatedList.next()) {
            this.saveRecord(relatedList);
            var relatedListEntry = new GlideRecord("sys_ui_related_list_entry");
            relatedListEntry.addQuery("list_id", relatedList.sys_id.toString());
            relatedListEntry.query();
            while (relatedListEntry.next())
                this.saveRecord(relatedListEntry);
        }

    },

    //Add access controls, access roles, & roles
    _addACLDependencies: function(acl, tableName) {
        var aclList = [];

        if (!gs.nil(tableName) && tableName == "sys_security_acl") {
            this.saveRecord(acl);
            aclList.push(acl.getValue("sys_id"));
        } else {
            var aclTableName = acl;
            acl = new GlideRecord("sys_security_acl");
            acl.addQuery("name", aclTableName).addOrCondition("name", "STARTSWITH", aclTableName + '.');
            acl.query();
            while (acl.next()) {
                this.saveRecord(acl);
                aclList.push(acl.getValue("sys_id"));
            }
        }

        var aclRole = new GlideRecord("sys_security_acl_role");
        aclRole.addQuery("sys_security_acl", "IN", aclList.toString());
        aclRole.query();
        while (aclRole.next()) {
            var role = new GlideRecord("sys_user_role");
            if (role.get(aclRole.sys_user_role.toString()))
                this.saveRecord(role);
            this.saveRecord(aclRole);
        }
    },

    //Add UI policies to the update set
    _addUIPolicyDependencies: function(uiPolicy, tableName) {
        var uiPolicyList = [];

        if (!gs.nil(tableName) && tableName == "sys_ui_policy") {
            this.saveRecord(uiPolicy);
            uiPolicyList.push(uiPolicy.getValue("sys_id"));
        } else {
            var uiPolicyTableName = uiPolicy;
            uiPolicy = new GlideRecord("sys_ui_policy");
            uiPolicy.addQuery("table", uiPolicyTableName);
            uiPolicy.query();
            while (uiPolicy.next()) {
                this.saveRecord(uiPolicy);
                uiPolicyList.push(uiPolicy.getValue("sys_id"));
            }
        }

        var uiPolicyAction = new GlideRecord("sys_ui_policy_action");
        uiPolicyAction.addQuery("ui_policy", "IN", uiPolicyList.toString());
        uiPolicyAction.query();
        while (uiPolicyAction.next())
            this.saveRecord(uiPolicyAction);
    },

    //Add data policies
    _addDataPolicyDependencies: function(dataPolicy, tableName) {
        var dataPolicyList = [];

        if (!gs.nil(tableName) && tableName == "sys_data_policy2") {
            this.saveRecord(dataPolicy);
            dataPolicyList.push(dataPolicy.getValue("sys_id"));
        } else {
            var dataPolicyTableName = dataPolicy;
            dataPolicy = new GlideRecord("sys_data_policy2");
            dataPolicy.addQuery("model_table", dataPolicyTableName);
            dataPolicy.query();
            while (dataPolicy.next()) {
                this.saveRecord(dataPolicy);
                dataPolicyList.push(dataPolicy.getValue("sys_id"));
            }
        }

        var dataPolicyRule = new GlideRecord("sys_data_policy_rule");
        dataPolicyRule.addQuery("sys_data_policy", "IN", dataPolicyList.toString());
        dataPolicyRule.query();
        while (dataPolicyRule.next())
            this.saveRecord(dataPolicyRule);
    },

    //Add modules and applications
    _addAppModuleDependencies: function(record, tableName) {
        this.saveRecord(record);

        var navModule = new GlideRecord("sys_app_module");
        navModule.addQuery("application", record.sys_id.toString());
        navModule.query();
        while (navModule.next()) {
            this.saveRecord(navModule);
        }
    },

    //Add field dependencies to the update set
    _addFieldDependencies: function(record, tableName) {
        //Add choices
        var choice = new GlideRecord("sys_choice");
        choice.addQuery("name", record.name.toString());
        choice.addQuery("element", record.element.toString());
        choice.query();
        while (choice.next())
            this.saveRecord(choice);
        //Add attributes
        var attributeM2M = new GlideRecord("sys_schema_attribute_m2m");
        attributeM2M.addQuery("schema", record.sys_id.toString());
        attributeM2M.query();
        while (attributeM2M.next()) {
            //Add attribute
            var attribute = new GlideRecord("sys_schema_attribute");
            if (attribute.get(attributeM2M.attribute.sys_id.toString()))
                this.saveRecord(attribute);
            //Add attribute m2m
            this.saveRecord(attributeM2M);
        }
        //Add labels
        var label = new GlideRecord("sys_documentation");
        label.addQuery("name", record.name.toString());
        label.addQuery("element", record.element.toString());
        label.query();
        while (label.next())
            this.saveRecord(label);
        //Add field styles
        var fieldStyle = new GlideRecord("sys_ui_style");
        fieldStyle.addQuery("name", record.name.toString());
        fieldStyle.addQuery("element", record.element.toString());
        fieldStyle.query();
        while (fieldStyle.next())
            this.saveRecord(fieldStyle);
        //Add dictionary overrides
        var override = new GlideRecord("sys_dictionary_override");
        override.addQuery("name", record.name.toString());
        override.addQuery("element", record.element.toString());
        override.query();
        while (override.next())
            this.saveRecord(override);
        //Add access controls, access roles, & roles (redundant for non-extended fields)
        var acl = new GlideRecord("sys_security_acl");
        acl.addQuery("name", record.name.toString() + '.' + record.element.toString());
        acl.query();
        while (acl.next()) {
            this.saveRecord(acl);
            var aclRole = new GlideRecord("sys_security_acl_role");
            aclRole.addQuery("sys_security_acl", acl.sys_id.toString());
            aclRole.query();
            while (aclRole.next()) {
                var role = new GlideRecord("sys_user_role");
                if (role.get(aclRole.sys_user_role.toString()))
                    this.saveRecord(role);
                this.saveRecord(aclRole);
            }
        }
    },

    //Add Database View
    _addDbView: function(record, tableName) {
        this.saveRecord(record);

        //Add Database View Table
        var dbViewTable = new GlideRecord("sys_db_view_table");
        dbViewTable.addQuery("view", record.sys_id.toString());
        dbViewTable.query();
        while (dbViewTable.next()) {
            this.saveRecord(dbViewTable);
            //Add Database View Fields
            var dbViewField = new GlideRecord("sys_db_view_table_field");
            dbViewField.addQuery("view_table", dbViewTable.sys_id.toString());
            dbViewField.query();
            while (dbViewField.next()) {
                this.saveRecord(dbViewField);
            }
            //Add dependent tables
            if (this.includeDbViewTables) {
                var dbViewSysDbObject = new GlideRecord("sys_db_object");
                dbViewSysDbObject.addQuery("name", dbViewTable.table.toString());
                dbViewSysDbObject.query();
                if (dbViewSysDbObject.next()) {
                    this._addDbObject(dbViewSysDbObject);
                }
            }
        }
    },

    /********************* End Table & Dictionary Functions *********************/

    /********************* Begin Integrations Functions *********************/

    _addRestMessage: function(restMessage, tableName) {
        var recID;
        if (typeof restMessage == "string") {
            recID = restMessage;
            restMessage = new GlideRecord("sys_rest_message");
            restMessage.get(recID);
        }
        this.saveRecord(restMessage);
        recID = restMessage.getValue("sys_id");

        var httpHeader = new GlideRecord("sys_rest_message_headers");
        httpHeader.addQuery("rest_message", recID);
        httpHeader.query();
        while (httpHeader.next()) {
            this.saveRecord(httpHeader);
        }
		
		this._addBasicAuthProfile(restMessage.getValue("basic_auth_profile"));

        var restFunction = new GlideRecord("sys_rest_message_fn");
        restFunction.addQuery("rest_message", recID);
        restFunction.query();
        while (restFunction.next()) {
            this._addRestFunction(restFunction);
        }
    },

    _addRestFunction: function(restFunction, tableName) {
        var recID;
        if (typeof restFunction == "string") {
            recID = restFunction;
            restFunction = new GlideRecord("sys_rest_message_fn");
            restFunction.get(recID);
        }
        this.saveRecord(restFunction);
        recID = restFunction.getValue("sys_id");

        var httpHeader = new GlideRecord("sys_rest_message_fn_headers");
        httpHeader.addQuery("rest_message_function", recID);
        httpHeader.query();
        while (httpHeader.next()) {
            this.saveRecord(httpHeader);
        }
		
		this._addBasicAuthProfile(restFunction.getValue("basic_auth_profile"));

        var queryParameter = new GlideRecord("sys_rest_message_fn_param_defs");
        queryParameter.addQuery("rest_message_function", recID);
        queryParameter.query();
        while (queryParameter.next()) {
            this.saveRecord(queryParameter);
        }

        var varSubstitution = new GlideRecord("sys_rest_message_fn_parameters");
        varSubstitution.addQuery("rest_message_function", recID);
        varSubstitution.query();
        while (varSubstitution.next()) {
            this.saveRecord(varSubstitution);
        }
    },

    //Add Scripted REST service
    _addScriptedRestService: function(record, tableName) {
        this.saveRecord(record);

        //Add REST resources
        var restResource = new GlideRecord("sys_ws_operation");
        restResource.addQuery("web_service_definition", record.sys_id.toString());
        restResource.query();
        while (restResource.next()) {
            this._addScriptedRestResource(restResource, restResource.getTableName());
        }

        //Add ACLs
        if (!record.enforce_acl.nil()) {
            var aclArray = record.enforce_acl.toString().split(',');
            for (var i = 0; i < aclArray.length; i++) {
                var aclRec = new GlideRecord('sys_security_acl');
                if (aclRec.get(aclArray[i])) {
                    this._addACLDependencies(aclRec, aclRec.getTableName());
                }
            }
        }
    },

    //Add Scripted REST resource
    _addScriptedRestResource: function(record, tableName) {
        this.saveRecord(record);

        //Add REST Service
        var restService = new GlideRecord("sys_ws_definition");
        if (restService.get(record.web_service_definition.toString())) {
            this.saveRecord(restService);
        }

        //Add Query Parameter M2M
        var queryParamM2M = new GlideRecord("sys_ws_query_parameter_map");
        queryParamM2M.addQuery("web_service_operation", record.sys_id.toString());
        queryParamM2M.query();
        while (queryParamM2M.next()) {
            //Add Query Parameter
            var queryParam = new GlideRecord("sys_ws_query_parameter");
            if (queryParam.get(queryParamM2M.web_service_query_parameter.toString())) {
                this.saveRecord(queryParam);
            }

            this.saveRecord(queryParamM2M);
        }

        //Add REST Header M2M
        var restHeaderM2M = new GlideRecord("sys_ws_header_map");
        restHeaderM2M.addQuery("web_service_operation", record.sys_id.toString());
        restHeaderM2M.query();
        while (restHeaderM2M.next()) {
            //Add Header
            var restHeader = new GlideRecord("sys_ws_header");
            if (restHeader.get(restHeaderM2M.web_service_header.toString())) {
                this.saveRecord(restHeader);
            }

            this.saveRecord(restHeaderM2M);
        }

        //Add ACLs
        if (!record.enforce_acl.nil()) {
            var aclArray = record.enforce_acl.toString().split(',');
            for (var i = 0; i < aclArray.length; i++) {
                var aclRec = new GlideRecord('sys_security_acl');
                if (aclRec.get(aclArray[i])) {
                    this._addACLDependencies(aclRec, aclRec.getTableName());
                }
            }
        }
    },

    //Add Scripted SOAP service
    _addScriptedSoapService: function(record, tableName) {
        this.saveRecord(record);

        //Add Input Parameters
        var soapInputParameter = new GlideRecord("sys_web_service_input");
        soapInputParameter.addQuery("web_service", record.sys_id.toString());
        soapInputParameter.query();
        while (soapInputParameter.next()) {
            this.saveRecord(soapInputParameter);
        }

        //Add OutputParameters
        var soapOutputParameter = new GlideRecord("sys_web_service_output");
        soapOutputParameter.addQuery("web_service", record.sys_id.toString());
        soapOutputParameter.query();
        while (soapOutputParameter.next()) {
            this.saveRecord(soapOutputParameter);
        }
    },

    _addSoapMessage: function(soapMessage, tableName) {
        var recID;
        if (typeof soapMessage == "string") {
            recID = soapMessage;
            soapMessage = new GlideRecord("sys_soap_message");
            soapMessage.get(recID);
        }
        this.saveRecord(soapMessage);
        recID = soapMessage.getValue("sys_id");
		
		this._addBasicAuthProfile(soapMessage.getValue("basic_auth_profile"));

        var soapFunction = new GlideRecord("sys_soap_message_function");
        soapFunction.addQuery("soap_message", recID);
        soapFunction.query();
        while (soapFunction.next()) {
            this._addSoapFunction(soapFunction);
        }
    },

    _addSoapFunction: function(soapFunction, tableName) {
        var recID;
        if (typeof soapFunction == "string") {
            recID = soapFunction;
            soapFunction = new GlideRecord("sys_rest_message_fn");
            soapFunction.get(recID);
        }
        this.saveRecord(soapFunction);
        recID = soapFunction.getValue("sys_id");
		
		this._addBasicAuthProfile(soapFunction.getValue("basic_auth_profile"));

        var varSubstitution = new GlideRecord("sys_soap_message_parameters");
        varSubstitution.addQuery("soap_function", recID);
        varSubstitution.query();
        while (varSubstitution.next()) {
            this.saveRecord(varSubstitution);
        }
    },

    _addTransformMap: function(transformMap, tableName) {
        this.saveRecord(transformMap);
        var recID = transformMap.getValue("sys_id");

        var fieldMap = new GlideRecord("sys_transform_entry");
        fieldMap.addQuery("map", recID);
        fieldMap.query();
        while (fieldMap.next()) {
            this.saveRecord(fieldMap);
        }

        var transformScript = new GlideRecord("sys_transform_script");
        transformScript.addQuery("map", recID);
        transformScript.query();
        while (transformScript.next()) {
            this.saveRecord(transformScript);
        }
    },
	
	_addBasicAuthProfile: function(basicAuthProfileID) {
		if (gs.nil(basicAuthProfileID)) {
			return;
		}
		
		var basicAuthProfile = new GlideRecord("sys_auth_profile_basic");
		if (basicAuthProfile.get(basicAuthProfileID)) {
			this.saveRecord(basicAuthProfile);
		}
	},

    /********************* End Integrations Functions *********************/

    addScheduledJob: function(scheduleJobFields) {
        var scheduledJob = new GlideRecord("sys_trigger");
        scheduledJob.newRecord();

        var keys = Object.keys(scheduleJobFields).toString();
        var keysList = keys.split(",");
        for (var i = 0; i < keysList.length; i++) {
            var fieldName = keysList[i].trim();
            var fieldValue = scheduleJobFields[fieldName].trim();
            if (!gs.nil(fieldValue) && scheduledJob.isValidField(fieldName)) {
                scheduledJob[fieldName] = fieldValue;
            }
        }
        this.saveRecord(scheduledJob, false);
    },

    parseTemplateString: function(templateString) {
        var templateObject = {};

        var templateArray = templateString.toString().split("^");
        for (var i = 0; i < templateArray.length; i++) {
            var fieldPair = templateArray[i].toString().split("=");
            templateObject[fieldPair[0]] = fieldPair[1];
        }

        return templateObject;
    },

    /********************* Begin Event Management Functions *********************/
    _addEMRule: function(emRule, tableName) {
        this.saveRecord(emRule);
        var emRuleID = emRule.getValue("sys_id");

        var composeField = new GlideRecord("em_compose_field");
        composeField.addQuery("match_rule", emRuleID);
        composeField.query();
        while (composeField.next()) {
            this.saveRecord(composeField);
        }

        var matchField = new GlideRecord("em_match_field");
        matchField.addQuery("match_rule", emRuleID);
        matchField.query();
        while (matchField.next()) {
            this.saveRecord(matchField);
        }
    },

    /********************* End Event Management Functions *********************/

    /********************* Begin Discovery Functions *********************/
    _addDiscoverySchedule: function(discoverySchedule, tableName) {
        this.saveRecord(discoverySchedule);
        var discoveryScheduleID = discoverySchedule.getValue("sys_id");

        var ipRangeItem = new GlideRecord("discovery_range_item");
        ipRangeItem.addQuery("schedule", discoveryScheduleID);
        ipRangeItem.query();
        while (ipRangeItem.next()) {
            this._addDiscoveryRangeItem(ipRangeItem);
        }

        var scheduleRange = new GlideRecord("discovery_schedule_range");
        scheduleRange.addQuery("dscheduler", discoveryScheduleID);
        scheduleRange.query();
        while (scheduleRange.next()) {
            this.saveRecord(scheduleRange);
            this._addDiscoveryRangeSet(scheduleRange.getValue("range"));
        }

        if (!gs.nil(discoverySchedule.getValue("behavior"))) {
            this._addDiscoveryBehavior(discoverySchedule.getValue("behavior"));
        }
    },

    _addDiscoveryRangeSet: function(discoveryRangeSet, tableName) {
        var recID;
        if (typeof discoveryRangeSet == "string") {
            recID = discoveryRangeSet;
            discoveryRangeSet = new GlideRecord("discovery_range");
            discoveryRangeSet.get(recID);
        }
        this.saveRecord(discoveryRangeSet);
        recID = discoveryRangeSet.getValue("sys_id");

        if (!gs.nil(discoveryRangeSet.getValue("behavior"))) {
            this._addDiscoveryBehavior(discoveryRangeSet.getValue("behavior"));
        }

        var ipRangeItem = new GlideRecord("discovery_range_item");
        ipRangeItem.addQuery("parent", recID);
        ipRangeItem.query();
        while (ipRangeItem.next()) {
            this._addDiscoveryRangeItem(ipRangeItem);
        }
    },

    _addDiscoveryRangeItem: function(rangeItem) {
        this.saveRecord(rangeItem);

        var ipRangeItemExcludeList = [];
        var ipRangeItemExclude = new GlideRecord("discovery_range_item_exclude");
        ipRangeItemExclude.addQuery("parent", rangeItem.getValue("sys_id"));
        ipRangeItemExclude.query();
        while (ipRangeItemExclude.next()) {
            this.saveRecord(ipRangeItemExclude);
            ipRangeItemExcludeList.push(ipRangeItemExclude.getValue("sys_id"));
        }

        var rangeItemIP = new GlideRecord("discovery_range_item_ip");
        rangeItemIP.addQuery("exclude_parent", "IN", ipRangeItemExcludeList.toString());
        rangeItemIP.query();
        while (rangeItemIP.next()) {
            this.saveRecord(rangeItemIP);
            ipRangeItemExcludeList.push(rangeItemIP.getValue("sys_id"));
        }
    },

    _addDiscoveryBehavior: function(discoveryBehavior, tableName) {
        var recID;
        if (typeof discoveryBehavior == "string") {
            recID = discoveryBehavior;
            discoveryBehavior = new GlideRecord("discovery_behavior");
            discoveryBehavior.get(recID);
        }
        if (!discoveryBehavior.isValidRecord()) {
            return;
        }

        this.saveRecord(discoveryBehavior);
        recID = discoveryBehavior.getValue("sys_id");

        var functionalityDefinition = new GlideRecord("discovery_functionality");
        if (functionalityDefinition.get(discoveryBehavior.getValue("functionality"))) {
            this.saveRecord(functionalityDefinition);
        }

        var functionCriterion = new GlideRecord("discovery_func_criterion");
        functionCriterion.addQuery("functionality", recID);
        functionCriterion.query();
        while (functionCriterion.next()) {
            this.saveRecord(functionCriterion);
        }
    },

    /********************* End Discovery Functions *********************/

    /********************* Begin ETL Functions *********************/
    //==================================================================================
    // Thanks to Alexis Osborne for these contributions to ATUS!
    // Must start on cmdb_inst_application_feed.  Select Add To UpdateSet in Related Links
    // All associated data for the ETL will be pulled into the current update set
    //==================================================================================

    _addETL: function(tableRec, tableName) {

        var etlID;
        if (typeof tableRec == "string") {
            etlID = tableRec;
            tableRec = new GlideRecord("cmdb_inst_application_feed"); //verified
            tableRec.get(etlID);

        }
        // CMDB Integration Studio Application Data Source (cmdb_inst_application_feed)  - extends Robust Transform Engine Entity Based Definition (sys_rte_definition)
        this.saveRecord(tableRec);
        etlID = tableRec.getValue("sys_id");

        //         var rteDef = new GlideRecord("sys_rte_definition");
        //         rteDef.addQuery("sys_rte_eb_definition", etlID);
        //         rteDef.query();
        //         while (rteDef.next()) {
        //             this.saveRecord(rteDef);
        //         }

        // Get upstream references *******************************************
        //   ETL CMDB Integration Studio Application
        var instApp = new GlideRecord("cmdb_inst_application"); //verified
        instApp.addQuery("sys_id", tableRec.cmdb_inst_application);
        instApp.query();
        while (instApp.next()) {
            this.saveRecord(instApp);
        }

        // Data Source
        var dataSource = new GlideRecord("sys_data_source");
        dataSource.addQuery("sys_id", tableRec.sys_data_source);
        dataSource.query();
        while (dataSource.next()) {
            this.saveRecord(dataSource);

            // Scheduled Data Import
            var schDataImport = new GlideRecord("scheduled_import_set");
            schDataImport.addQuery("data_source", dataSource.sys_id);
            schDataImport.query();
            while (schDataImport.next()) {
                this.saveRecord(schDataImport);

            }
        }
        // End  upstream references *******************************************


        // Begin Downstream tables  *******************************************

        // Get downstream references- CMDB Integration Studio Entity(cmdb_inst_entity) extends(sys_rte_eb_entity) - only query against parent table
        //         var instEntity = new GlideRecord("cmdb_inst_entity");
        //         instEntity.addQuery("sys_rte_eb_definition", etlID);
        //         instEntity.query();
        //         while (instEntity.next()) {
        //             this.saveRecord(instEntity);
        //         }

        // Get downstream references- Robust Transform Engine Entity
        var retEBEntity = new GlideRecord("sys_rte_eb_entity"); // confirm - extended by cmdb_inst_entity
        retEBEntity.addQuery("sys_rte_eb_definition", etlID);
        retEBEntity.query();
        while (retEBEntity.next()) {
            this.saveRecord(retEBEntity);
        }


        //  dependent tables(tabs):  sys_rte_eb_field(done)   sys_rte_eb_operation(done)
        // Get downstream references- CMDB Intgration Studio Entry  dependent table: Robust Transform Engine Entity Field (sys_rte_eb_field)
        var rteEBField = new GlideRecord("sys_rte_eb_field"); // verified
        rteEBField.addQuery("sys_rte_eb_definition", etlID);
        rteEBField.query();
        while (rteEBField.next()) {
            this.saveRecord(rteEBField);
        }


        // Get downstream references- CMDB Intgration Studio Entry  dependent tables: Robust Transform Engine Entity Template Operation (22) sys_rte_eb_*
        // This is a base table for a large number of sys_rte_eb_* tables.  Robust Transform Engine Entity ...Cleanse, Derive, Create...

        //         var rteEBOp = new GlideRecord("sys_rte_eb_operation"); // verified
        //         rteEBOp.addQuery("sys_rte_eb_definition", etlID);
        //         rteEBOp.query();
        //         while (rteEBOp.next()) {
        //             this.saveRecord(rteEBOp);
        //         }


        var rteConcat = new GlideRecord("sys_rte_eb_concat_operation"); // verified
        rteConcat.addQuery("sys_rte_eb_definition", etlID);
        rteConcat.query();
        while (rteConcat.next()) {
            this.saveRecord(rteConcat);
        }

        var rteCopy = new GlideRecord("sys_rte_eb_copy_operation"); // verified
        rteCopy.addQuery("sys_rte_eb_definition", etlID);
        rteCopy.query();
        while (rteCopy.next()) {
            this.saveRecord(rteCopy);
        }

        var rteExNum = new GlideRecord("sys_rte_eb_extract_numeric_operation"); // verified
        rteExNum.addQuery("sys_rte_eb_definition", etlID);
        rteExNum.query();
        while (rteExNum.next()) {
            this.saveRecord(rteExNum);
        }

        var rteGlide = new GlideRecord("sys_rte_eb_glide_lookup_operation"); // verified
        rteGlide.addQuery("sys_rte_eb_definition", etlID);
        rteGlide.query();
        while (rteGlide.next()) {
            this.saveRecord(rteGlide);
        }

        var rteMinMax = new GlideRecord("sys_rte_eb_min_max_operation"); // verified
        rteMinMax.addQuery("sys_rte_eb_definition", etlID);
        rteMinMax.query();
        while (rteMinMax.next()) {
            this.saveRecord(rteMinMax);
        }

        var rteMulti = new GlideRecord("sys_rte_eb_multi_in_script_operation"); // verified
        rteMulti.addQuery("sys_rte_eb_definition", etlID);
        rteMulti.query();
        while (rteMulti.next()) {
            this.saveRecord(rteMulti);
        }

        var rteRegex = new GlideRecord("sys_rte_eb_regex_replace_operation"); // verified
        rteRegex.addQuery("sys_rte_eb_definition", etlID);
        rteRegex.query();
        while (rteRegex.next()) {
            this.saveRecord(rteRegex);
        }

        var rteRepl = new GlideRecord("sys_rte_eb_replace_operation"); // verified
        rteRepl.addQuery("sys_rte_eb_definition", etlID);
        rteRepl.query();
        while (rteRepl.next()) {
            this.saveRecord(rteRepl);
        }

        var rteRound = new GlideRecord("sys_rte_eb_round_numeric_operation"); // verified
        rteRound.addQuery("sys_rte_eb_definition", etlID);
        rteRound.query();
        while (rteRound.next()) {
            this.saveRecord(rteRound);
        }

        var rteScript = new GlideRecord("sys_rte_eb_script_operation"); // verified
        rteScript.addQuery("sys_rte_eb_definition", etlID);
        rteScript.query();
        while (rteScript.next()) {
            this.saveRecord(rteScript);
        }

        var rteSet = new GlideRecord("sys_rte_eb_set_operation"); // verified
        rteSet.addQuery("sys_rte_eb_definition", etlID);
        rteSet.query();
        while (rteSet.next()) {
            this.saveRecord(rteSet);
        }

        var rteSplit = new GlideRecord("sys_rte_eb_split_operation"); // verified
        rteSplit.addQuery("sys_rte_eb_definition", etlID);
        rteSplit.query();
        while (rteSplit.next()) {
            this.saveRecord(rteSplit);
        }

        var rteTempl = new GlideRecord("sys_rte_eb_template_operation"); // verified
        rteTempl.addQuery("sys_rte_eb_definition", etlID);
        rteTempl.query();
        while (rteTempl.next()) {
            this.saveRecord(rteTempl);
        }

        var rteBoo = new GlideRecord("sys_rte_eb_to_boolean_operation"); // verified
        rteBoo.addQuery("sys_rte_eb_definition", etlID);
        rteBoo.query();
        while (rteBoo.next()) {
            this.saveRecord(rteBoo);
        }

        var rteDate = new GlideRecord("sys_rte_eb_to_date_operation"); // verified
        rteDate.addQuery("sys_rte_eb_definition", etlID);
        rteDate.query();
        while (rteDate.next()) {
            this.saveRecord(rteDate);
        }

        var rteToNum = new GlideRecord("sys_rte_eb_to_numeric_operation"); // verified
        rteToNum.addQuery("sys_rte_eb_definition", etlID);
        rteToNum.query();
        while (rteToNum.next()) {
            this.saveRecord(rteToNum);
        }

        var rteTrim = new GlideRecord("sys_rte_eb_trim_operation"); // verified
        rteTrim.addQuery("sys_rte_eb_definition", etlID);
        rteTrim.query();
        while (rteTrim.next()) {
            this.saveRecord(rteTrim);
        }

        var rteUp = new GlideRecord("sys_rte_eb_upper_case_operation"); // verified
        rteUp.addQuery("sys_rte_eb_definition", etlID);
        rteUp.query();
        while (rteUp.next()) {
            this.saveRecord(rteUp);
        }

        var rteUpTrim = new GlideRecord("sys_rte_eb_upper_case_trim_operation");
        rteUpTrim.addQuery("sys_rte_eb_definition", etlID);
        rteUpTrim.query();
        while (rteUpTrim.next()) {
            this.saveRecord(rteUpTrim);
        }


        // Get downstream references- Robust Transform Engine Entity Mapping
        var rteEBEntMap = new GlideRecord("sys_rte_eb_entity_mapping"); //verified
        rteEBEntMap.addQuery("sys_rte_eb_definition", etlID);
        rteEBEntMap.query();
        while (rteEBEntMap.next()) {
            this.saveRecord(rteEBEntMap);
        }

        // Get downstream references- Robust TRansform Engine Entity Field Mappings
        var rteEBFieldMap = new GlideRecord("sys_rte_eb_field_mapping"); //verified
        rteEBFieldMap.addQuery("sys_rte_eb_definition", etlID);
        rteEBFieldMap.query();
        while (rteEBFieldMap.next()) {
            this.saveRecord(rteEBFieldMap);
        }

        // Get downstream references- Robust Transform Engine Entity Template Operations -- base table for all of the sn_cmdb_int_cleanse_* functions.    

        //Robust Transform Engine Entity Cleanse IP Version Operation
        var cIPVersion = new GlideRecord("sn_cmdb_int_util_cleanse_ip_version_operation");
        cIPVersion.addQuery("sys_rte_eb_definition", etlID);
        cIPVersion.query();
        while (cIPVersion.next()) {
            this.saveRecord(cIPVersion);
        }

        //Robust Transform Engine Entity Cleanse MAC Operation
        var cMacOper = new GlideRecord("sn_cmdb_int_util_cleanse_mac_operation");
        cMacOper.addQuery("sys_rte_eb_definition", etlID);
        cMacOper.query();
        while (cMacOper.next()) {
            this.saveRecord(cMacOper);
        }

        //Robust Transform Engine Entity Cleanse OS Operation
        var cOSOper = new GlideRecord("sn_cmdb_int_util_cleanse_os_operation");
        cOSOper.addQuery("sys_rte_eb_definition", etlID);
        cOSOper.query();
        while (cOSOper.next()) {
            this.saveRecord(cOSOper);
        }

        //Robust Transform Engine Entity Cleanse Serial Number Operation
        var cSerialNum = new GlideRecord("sn_cmdb_int_util_cleanse_serial_number_operation");
        cSerialNum.addQuery("sys_rte_eb_definition", etlID);
        cSerialNum.query();
        while (cSerialNum.next()) {
            this.saveRecord(cSerialNum);
        }

        //Robust Transform Engine Entity Cleanse Software Model Operation
        var cSoftWModel = new GlideRecord("sn_cmdb_int_util_cleanse_software_model_operation");
        cSoftWModel.addQuery("sys_rte_eb_definition", etlID);
        cSoftWModel.query();
        while (cSoftWModel.next()) {
            this.saveRecord(cSoftWModel);
        }
        // //Robust Transform Engine Entity Create Software Instance Name Operation

        var cSoftwInstName = new GlideRecord("sn_cmdb_int_util_create_software_instance_name_operation");
        cSoftwInstName.addQuery("sys_rte_eb_definition", etlID);
        cSoftwInstName.query();
        while (cSoftwInstName.next()) {
            this.saveRecord(cSoftwInstName);
        }

        // //Robust Transform Engine Entity Derive Class From Model Operation
        var dClassFrmModel = new GlideRecord("sn_cmdb_int_util_derive_class_from_model_operation");
        dClassFrmModel.addQuery("sys_rte_eb_definition", etlID);
        dClassFrmModel.query();
        while (dClassFrmModel.next()) {
            this.saveRecord(dClassFrmModel);
        }

        //Robust Transform Engine Entity Derive Class From Native Value Operation
        var dClassFromNativeV = new GlideRecord("sn_cmdb_int_util_derive_class_from_native_value_operation");
        dClassFromNativeV.addQuery("sys_rte_eb_definition", etlID);
        dClassFromNativeV.query();
        while (dClassFromNativeV.next()) {
            this.saveRecord(dClassFromNativeV);
        }

        //Robust Transform Engine Entity Derive Class From OS Operation
        var dClassFromOS = new GlideRecord("sn_cmdb_int_util_derive_class_from_os_operation");
        dClassFromOS.addQuery("sys_rte_eb_definition", etlID);
        dClassFromOS.query();
        while (dClassFromOS.next()) {
            this.saveRecord(dClassFromOS);
        }

        //Robust Transform Engine Entity Derive Virtual From Model Operation
        var dVirtualFromModel = new GlideRecord("sn_cmdb_int_util_derive_virtual_from_model_operation");
        dVirtualFromModel.addQuery("sys_rte_eb_definition", etlID);
        dVirtualFromModel.query();
        while (dVirtualFromModel.next()) {
            this.saveRecord(dVirtualFromModel);

        }

        //Robust Transform Engine Entity Derive Virtual From Native Value Operation
        var dVirtualFromNativeV = new GlideRecord("sn_cmdb_int_util_derive_virtual_from_native_value_operation");
        dVirtualFromNativeV.addQuery("sys_rte_eb_definition", etlID);
        dVirtualFromNativeV.query();
        while (dVirtualFromNativeV.next()) {
            this.saveRecord(dVirtualFromNativeV);
        }

        //Robust Transform Engine Entity Derive Virtual From Serial Number Operation
        var dVirtualFromSerialNum = new GlideRecord("sn_cmdb_int_util_derive_virtual_from_serial_number_operation");
        dVirtualFromSerialNum.addQuery("sys_rte_eb_definition", etlID);
        dVirtualFromSerialNum.query();
        while (dVirtualFromSerialNum.next()) {
            this.saveRecord(dVirtualFromSerialNum);
        }

        //Robust Transform Engine Entity Extract and Scale by Units Operation
        var extractScale = new GlideRecord("sn_cmdb_int_util_extract_and_scale_by_units_operation");
        extractScale.addQuery("sys_rte_eb_definition", etlID);
        extractScale.query();
        while (extractScale.next()) {
            this.saveRecord(extractScale);
        }

        //Robust Transform Engine Entity First Non Null Value Operation
        var firstNonNull = new GlideRecord("sn_cmdb_int_util_first_non_null_operation");
        firstNonNull.addQuery("sys_rte_eb_definition", etlID);
        firstNonNull.query();
        while (firstNonNull.next()) {
            this.saveRecord(firstNonNull);
        }

        //Robust Transform Engine Entity Process FQDN Operation
        var processFQDN = new GlideRecord("sn_cmdb_int_util_process_fqdn_operation");
        processFQDN.addQuery("sys_rte_eb_definition", etlID);
        processFQDN.query();
        while (processFQDN.next()) {
            this.saveRecord(processFQDN);
        }

        //Robust Transform Engine Entity Process Name Set Operation
        var nameSet = new GlideRecord("sn_cmdb_int_util_process_name_set_operation");
        nameSet.addQuery("sys_rte_eb_definition", etlID);
        nameSet.query();
        while (nameSet.next()) {
            this.saveRecord(nameSet);
        }

        //Robust Transform Engine Entity Scale Unit Operation
        var scaleUnit = new GlideRecord("sn_cmdb_int_util_scale_unit_operation");
        scaleUnit.addQuery("sys_rte_eb_definition", etlID);
        scaleUnit.query();
        while (scaleUnit.next()) {
            this.saveRecord(scaleUnit);
        }

        //Robust Transform Engine Entity Software Bundle Id Lookup Operation
        var softwareBundle = new GlideRecord("sn_cmdb_int_util_software_bundle_id_lookup_operation");
        softwareBundle.addQuery("sys_rte_eb_definition", etlID);
        softwareBundle.query();
        while (softwareBundle.next()) {
            this.saveRecord(softwareBundle);
        }

        //Robust Transform Engine Entity User Lookup Operation
        var userLookup = new GlideRecord("sn_cmdb_int_util_user_lookup_operation");
        userLookup.addQuery("sys_rte_eb_definition", etlID);
        userLookup.query();
        while (userLookup.next()) {
            this.saveRecord(userLookup);
        }



        // Get downstream references - Robust Import Set Transformer
        var robustTrans = new GlideRecord("sys_robust_import_set_transformer"); // verified
        robustTrans.addQuery("robust_transform_engine", etlID);
        robustTrans.query();
        while (robustTrans.next()) {
            this.saveRecord(robustTrans);
        }


        //==================================================================================
        // No rows, not included:
        // sys_rte_pattern 
        // sys_rte_transformer_definition 
        //sn_cmdb_int_util_class_recommendation_state  -- no rows at this time
        //sn_int_studio_template_state - do not capture - reference to import set (transient data)
        //==================================================================================


    },

    /********************* End ETL Functions *********************/

    /********************* Begin AI Search Functions *********************/

    _addSearchContext: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var searchContextID = tableRec.getValue("sys_id");

        if (tableRec.getValue('search_engine') == 'zing'){
            var searchSourceM2M = new GlideRecord("m2m_search_context_config_search_source");
            searchSourceM2M.addQuery("search_context_config", searchContextID);
            searchSourceM2M.query();
            while (searchSourceM2M.next()) {
                var searchSource = searchSourceM2M.source.getRefRecord();
                this.saveRecord(searchSource);
                this.saveRecord(searchSourceM2M);
            }
        }
        if (tableRec.getValue('search_engine') == 'ai_search'){
            var searchProfileRec = tableRec.search_profile.getRefRecord();
            this._addAiSearchProfile(searchProfileRec, searchProfileRec.getTableName());

            var searchFacet = new GlideRecord("sys_search_facet");
            searchFacet.addQuery("search_context_config", searchContextID);
            searchFacet.query();
            while (searchFacet.next()) {
                this.saveRecord(searchFacet);
            }

            var searchFilter = new GlideRecord("sys_search_filter");
            searchFilter.addQuery("search_context_config", searchContextID);
            searchFilter.query();
            while (searchFilter.next()) {
                this.saveRecord(searchFilter);
            }

            var searchSuggestion = new GlideRecord("sys_suggestion_reader_group");
            searchSuggestion.addQuery("context_config_id", searchContextID);
            searchSuggestion.query();
            while (searchSuggestion.next()) {
                this.saveRecord(searchSuggestion);
            }

            var searchScriptedPostProcessorM2M = new GlideRecord("m2m_search_context_config_search_scripted_processor");
            searchScriptedPostProcessorM2M.addQuery("search_context_config", searchContextID);
            searchScriptedPostProcessorM2M.query();
            while (searchScriptedPostProcessorM2M.next()) {
                var searchScriptedProcessorRec = searchScriptedPostProcessorM2M.search_scripted_processor.getRefRecord();
                this.saveRecord(searchScriptedProcessorRec);
                this.saveRecord(searchScriptedPostProcessorM2M);
            }

            var searchSortOption = new GlideRecord("sys_search_sort_option");
            searchSortOption.addQuery("search_context_config", searchContextID);
            searchSortOption.query();
            while (searchSortOption.next()) {
                this.saveRecord(searchSortOption);
            }
        }
    },

    _addAiSearchProfile: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var profileID = tableRec.getValue("sys_id");

        var searchSourceM2M = new GlideRecord("ais_search_profile_ais_search_source_m2m");
        searchSourceM2M.addQuery("profile", profileID);
        searchSourceM2M.query();
        while (searchSourceM2M.next()) {
            var searchSource = searchSourceM2M.search_source.getRefRecord();
            this._addAiSearchSource(searchSource, searchSource.getTableName());
            this.saveRecord(searchSourceM2M);
        }

        var dictRecM2M = new GlideRecord("ais_search_profile_ais_dictionary_m2m");
        dictRecM2M.addQuery("profile", profileID);
        dictRecM2M.query();
        while (dictRecM2M.next()) {
            var dictionaryRec = tableRec.dictionary.getRefRecord();
            this._addDictionary(dictionaryRec, dictionaryRec.getTableName());
            this.saveRecord(dictRecM2M);
        }

        var geniusRecM2M = new GlideRecord("ais_search_profile_ais_genius_result_configuration_m2m");
        geniusRecM2M.addQuery("profile", profileID);
        geniusRecM2M.query();
        while (geniusRecM2M.next()) {
            var geniusRec = tableRec.genius_result_configuration.getRefRecord();
            this.saveRecord(geniusRec);
            this.saveRecord(geniusRecM2M);
        }

        var resultImpRule = new GlideRecord("ais_rule");
        resultImpRule.addQuery("profile", profileID);
        resultImpRule.query();
        while (resultImpRule.next()) {
            this.saveRecord(resultImpRule);
            var actionRec = new GlideRecord("ais_rule_action");
            actionRec.addQuery("rule", resultImpRule.getValue('sys_id'));
            actionRec.query();
            while (actionRec.next()) {
                this.saveRecord(actionRec);
            }
        }
    },

    _addAiSearchSource: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var aiSearchDatasource = tableRec.datasource.getRefRecord();
        this._addAiSearchDatasource(aiSearchDatasource, aiSearchDatasource.getTableName());
    },

    _addAiSearchDatasource: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var dataSourceID = tableRec.getValue("sys_id");

        var childTable = new GlideRecord("ais_child_table");
        childTable.addQuery("datasource", dataSourceID);
        childTable.query();
        while (childTable.next()) {
            this.saveRecord(childTable);
        }

        var indSourceAttribute = new GlideRecord("ais_datasource_attribute");
        indSourceAttribute.addQuery("datasource", dataSourceID);
        indSourceAttribute.query();
        while (indSourceAttribute.next()) {
            var confAttribute = new GlideRecord("ais_configuration_attribute");
            confAttribute.addQuery("sys_id", indSourceAttribute.attribute.toString());
            confAttribute.query();
            if (confAttribute.next()) {
                this.saveRecord(confAttribute);
            }
            this.saveRecord(indSourceAttribute);
        }

        var fieldSetting = new GlideRecord("ais_datasource_field_attribute");
        fieldSetting.addQuery("datasource", dataSourceID);
        fieldSetting.query();
        while (fieldSetting.next()) {
            var confAttribute = new GlideRecord("ais_configuration_attribute");
            confAttribute.addQuery("sys_id", fieldSetting.attribute.toString());
            confAttribute.query();
            if (confAttribute.next()) {
                this.saveRecord(confAttribute);
            }
            this.saveRecord(fieldSetting);
        }
    },

    _addDictionary: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var dictionaryID = tableRec.getValue("sys_id");

        var dictTerm = new GlideRecord("ais_dictionary_term");
        dictTerm.addQuery("dictionary", dictionaryID);
        dictTerm.query();
        while (dictTerm.next()) {
            this.saveRecord(dictTerm);
        }
    },

    /********************* End AI Search Functions *********************/

    /********************* Begin Taxonomy Functions *********************/
    /* Note: We do not gather SP Pages, Knowledge Categories/Articles, Catalog Categories/Articles, or User Criteria */

    _addTaxonomy: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var taxonomyID = tableRec.getValue("sys_id");

        var topicRec = new GlideRecord("topic");
        topicRec.addQuery("taxonomy", taxonomyID);
        topicRec.query();
        while (topicRec.next()) {
            this._addTaxonomyTopic(topicRec, topicRec.getTableName());
        }

        var taxonomyContributorM2M = new GlideRecord("m2m_taxonomy_contributor");
        taxonomyContributorM2M.addQuery("taxonomy", taxonomyID);
        taxonomyContributorM2M.query();
        while (taxonomyContributorM2M.next()) {
            this.saveRecord(taxonomyContributorM2M);
        }
    },

    _addTaxonomyTopic: function(tableRec, tableName) {
        this.saveRecord(tableRec);
        var topicId = tableRec.getValue("sys_id");

        var connectedContentM2M = new GlideRecord("m2m_connected_content");
        connectedContentM2M.addQuery("topic", topicId);
        connectedContentM2M.query();
        while (connectedContentM2M.next()) {
            //Add Quick Links
            if (connectedContentM2M.content_type.toString() == '07f4b6bfe75430104cda66ef11e8a9a9'){
                var quickLink = connectedContentM2M.quick_link.getRefRecord();
                this._addQuickLink(quickLink, quickLink.getTableName());
            }
            this.saveRecord(connectedContentM2M);
        }

        var featuredContent = new GlideRecord("featured_content");
        featuredContent.addQuery("topic", topicId);
        featuredContent.query();
        while (featuredContent.next()) {
            this.saveRecord(featuredContent);
        }

        var connectedCategoryM2M = new GlideRecord("m2m_connected_category");
        connectedCategoryM2M.addQuery("topic", topicId);
        connectedCategoryM2M.query();
        while (connectedCategoryM2M.next()) {
            this.saveRecord(connectedCategoryM2M);
        }

        var topicRec = new GlideRecord("topic");
        topicRec.addQuery("parent_topic", topicId);
        topicRec.query();
        while (topicRec.next()) {
            this._addTaxonomyTopic(topicRec, topicRec.getTableName());
        }
    },

    _addQuickLink: function(tableRec, tableName) {
        if (tableRec.content_type.toString() == 'external_link'){
            var externalLink = tableRec.external_link.getRefRecord();
            this.saveRecord(externalLink);
        }

        this.saveRecord(tableRec);
    },

    /********************* End Taxonomy Functions *********************/

    /********************* Begin Change Management Functions *********************/

	_addChangeModel: function(tableRec, tableName) {
		this.saveRecord(tableRec);
		var recID = tableRec.getValue("sys_id");

		var modelState = new GlideRecord("sttrm_state");
		modelState.addQuery("sttrm_model", recID);
		modelState.query();
		while (modelState.next()) {
			this._addModelState(modelState, modelState.getTableName());
		}
	},

	_addModelState: function(tableRec, tableName) {
		this.saveRecord(tableRec);
		var recID = tableRec.getValue("sys_id");

		var modelStateTransition = new GlideRecord("sttrm_state_transition");
		modelStateTransition.addQuery("from_state", recID);
		modelStateTransition.query();
		while (modelStateTransition.next()) {
			this._addModelStateTransition(modelStateTransition, modelStateTransition.getTableName());
		}
	},

	_addModelStateTransition: function(tableRec, tableName) {
		this.saveRecord(tableRec);
		var recID = tableRec.getValue("sys_id");

		var modelStateTransitionCondition = new GlideRecord("sttrm_transition_condition");
		modelStateTransitionCondition.addQuery("sttrm_state_transition", recID);
		modelStateTransitionCondition.query();
		while (modelStateTransitionCondition.next()) {
			this.saveRecord(modelStateTransitionCondition);
		}
	},

	/********************* End Change Management Functions *********************/

    /********************* Begin Decision Table Functions *********************/

	_addDecisionTable: function(tableRec, tableName) {
		this.saveRecord(tableRec);
		var recID = tableRec.getValue("sys_id");

		var decisionInput = new GlideRecord("sys_decision_input");
		decisionInput.addQuery("model", recID);
		decisionInput.query();
		while (decisionInput.next()) {
			this.saveRecord(decisionInput);
		}

        var decisionTableAnswerTable = tableRec.answer_table.toString();
        var decisionQuestion = new GlideRecord("sys_decision_question");
		decisionQuestion.addQuery("decision_table", recID);
		decisionQuestion.query();
		while (decisionQuestion.next()) {
			this.saveRecord(decisionQuestion);

            var decisionQuestionAnswer = new GlideRecord(decisionTableAnswerTable);
            decisionQuestionAnswer.addQuery("sys_id", decisionQuestion.answer.toString());
            decisionQuestionAnswer.query();
            if (decisionQuestionAnswer.next()) {
                this.saveRecord(decisionQuestionAnswer);  
            }
		}

        var decisionTableDecisionCondition = new GlideRecord("sn_decision_table_decision_condition");
		decisionTableDecisionCondition.addQuery("decision_table", recID);
		decisionTableDecisionCondition.query();
		while (decisionTableDecisionCondition.next()) {
			this.saveRecord(decisionTableDecisionCondition);
		}

        var dtDocumentation = new GlideRecord("sys_documentation");
		dtDocumentation.addQuery("name", "CONTAINS", recID);
		dtDocumentation.query();
		while (dtDocumentation.next()) {
			this.saveRecord(dtDocumentation);
		}

        var decisionTableRule = new GlideRecord("sn_nb_action_decision_table_rule");
		decisionTableRule.addQuery("decision_table", recID);
		decisionTableRule.query();
		while (decisionTableRule.next()) {
			this.saveRecord(decisionTableRule);

            var actionTypeDefinition = new GlideRecord("sn_nb_action_type_definition");
            actionTypeDefinition.addQuery("sys_id", decisionTableRule.action_type.toString());
            actionTypeDefinition.query();
            if (actionTypeDefinition.next()) {
                this.saveRecord(actionTypeDefinition);
            }
		}

        //Disabled by default - only needed if Decision Table results are needed
        /*var decisionMultiResult = new GlideRecord("sys_decision_multi_result");
		decisionMultiResult.addQuery("decision_table", recID);
		decisionMultiResult.query();
		while (decisionMultiResult.next()) {
			this.saveRecord(decisionMultiResult);
		}
        
        var decisionMultiResultElement = new GlideRecord("sys_decision_multi_result_element");
		decisionMultiResultElement.addQuery("model", recID);
		decisionMultiResultElement.query();
		while (decisionMultiResultElement.next()) {
			this.saveRecord(decisionMultiResultElement);

            var variableValue = new GlideRecord("sys_variable_value");
            variableValue.addQuery("document_key", decisionMultiResultElement.sys_id.toString());
            variableValue.query();
            while (variableValue.next()) {
                this.saveRecord(variableValue);
            }
		}*/
	},

	/********************* End Decision Table Functions *********************/

    type: 'addToUpdateSetUtils'
};